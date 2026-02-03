import { ModalClient, type Sandbox } from "modal";
import { loadConfig, type AppConfig } from "../../src/runtime/config.js";
import { createProxyToken } from "../../src/runtime/cloud/proxy.js";
import { Kysely, SqliteDialect } from "kysely";
import Database from "better-sqlite3";
import type { DatabaseSchema } from "../../src/runtime/db.js";
import type { UserLanguage } from "../../src/locales/index.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Helper to parse SQLAlchemy-style SQLite URLs
function parseSqliteFilePath(sqliteUrl: string, baseDir: string): string {
  // Supports SQLAlchemy-style:
  // - sqlite+aiosqlite:///./relative.db
  // - sqlite:////absolute/path.db
  // - sqlite:///:memory:
  const m = sqliteUrl.match(/^sqlite(?:\+[^:]+)?:([/]{0,4})(.*)$/);
  if (!m) throw new Error(`Invalid sqlite URL: ${sqliteUrl}`);
  const slashes = m[1] ?? "";
  const rest = m[2] ?? "";
  if (rest === ":memory:" || rest.startsWith(":memory:")) return ":memory:";
  if (slashes === "////") return `/${rest}`;
  if (slashes === "///") return path.resolve(baseDir, rest);
  if (slashes === "//") throw new Error(`sqlite URL with authority not supported: ${sqliteUrl}`);
  return path.resolve(baseDir, `${slashes}${rest}`);
}

// Type for ws library WebSocket (Node.js, not browser)
// Import the type from the ws package
import type { WebSocket as WebSocketWs, RawData } from "ws";

export interface E2EConfig {
  wsUrl: string;
  modalTokenId: string;
  modalTokenSecret: string;
  modalEnvironment?: string;
  modalEndpoint?: string;
  requestTimeoutMs: number;
  proxySecret: string;
  dataDir: string;
  configDir: string;
  dbUrl: string;
}

export interface E2EFixtures {
  config: E2EConfig;
  testIdentityId: string;
  testRepoId: string;
}

const E2E_TIMEOUTS = {
  wsConnect: 5000,
  authResponse: 3000,
  sessionStarted: 60000,
  fileRead: 10000,
  cleanup: 30000,
};

export async function loadE2EConfig(configPath: string): Promise<E2EConfig> {
  const config = await loadConfig(configPath);

  const wsPort = config.bot.port;
  const wsPath = config.websocket?.path ?? "/api/ws/chat";

  // For E2E tests, always use localhost (not public_base_url which may be a placeholder)
  const wsUrl = `ws://localhost:${wsPort}${wsPath}`;

  const cloud = config.cloud;
  if (!cloud?.enabled) {
    throw new Error("Cloud mode must be enabled for E2E tests");
  }
  if (!cloud.modal?.token_id || !cloud.modal?.token_secret) {
    throw new Error("Modal token_id and token_secret must be configured");
  }
  if (!cloud.proxy?.shared_secret) {
    throw new Error("Proxy shared_secret must be configured for auth tokens");
  }

  return {
    wsUrl,
    modalTokenId: cloud.modal.token_id,
    modalTokenSecret: cloud.modal.token_secret,
    modalEnvironment: cloud.modal.environment || undefined,
    modalEndpoint: cloud.modal.endpoint || undefined,
    requestTimeoutMs: cloud.modal.request_timeout_ms || 300_000,
    proxySecret: cloud.proxy.shared_secret,
    dataDir: config.bot.data_dir,
    configDir: config.config_dir,
    dbUrl: config.db.url,
  };
}

export class WebSocketClient {
  private ws: WebSocketWs | null = null;
  private messageBuffer: any[] = [];
  private pendingWaits: Array<{
    predicate: (msg: any) => boolean;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeoutMs: number;
  }> = [];

  constructor(private url: string) {}

  async connect(): Promise<void> {
    // Import ws dynamically - it's a CJS module that works with createRequire
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    let WebSocketClass: any;

    try {
      WebSocketClass = require("ws");
    } catch {
      return Promise.reject(new Error("ws module not available. Install with: npm install ws"));
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocketClass(this.url);

      if (!this.ws) {
        reject(new Error("Failed to create WebSocket"));
        return;
      }

      this.ws.on("open", () => {
        resolve();
      });

      this.ws.on("error", (err: Error) => {
        reject(new Error(`WebSocket error: ${err.message}`));
      });

      this.ws.on("message", (data: RawData) => {
        try {
          const msg = JSON.parse(data.toString());

          // Add to buffer
          this.messageBuffer.push(msg);

          // Check pending waits
          for (let i = this.pendingWaits.length - 1; i >= 0; i--) {
            const pending = this.pendingWaits[i];
            if (pending && pending.predicate(msg)) {
              this.pendingWaits.splice(i, 1);
              pending.resolve(msg);
              return;
            }
          }
        } catch (e) {
          console.error("[ws] Failed to parse message:", e);
        }
      });

      setTimeout(() => reject(new Error("WebSocket connect timeout")), E2E_TIMEOUTS.wsConnect);
    });
  }

  send(data: object): void {
    if (!this.ws) throw new Error("WebSocket not connected");
    this.ws.send(JSON.stringify(data));
  }

  async waitForMessage(predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
    // Check buffer first
    for (const msg of this.messageBuffer) {
      if (predicate(msg)) {
        // Remove matched message from buffer
        const idx = this.messageBuffer.indexOf(msg);
        if (idx >= 0) this.messageBuffer.splice(idx, 1);
        return msg;
      }
    }

    // Wait for new message
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.pendingWaits.findIndex((w) => w.predicate === predicate);
        if (idx >= 0) {
          this.pendingWaits.splice(idx, 1);
        }
        reject(new Error(`Timeout waiting for message (timeout=${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingWaits.push({
        predicate,
        resolve: (msg: any) => {
          clearTimeout(timeout);
          resolve(msg);
        },
        reject: (reason: any) => {
          clearTimeout(timeout);
          reject(reason);
        },
        timeoutMs,
      });
    });
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export async function getSandboxById(client: ModalClient, sandboxId: string): Promise<Sandbox> {
  // Use the same pattern as ModalCloudProvider.getOrFetchSandbox
  const fromId = (client as any).sandboxes?.fromId;
  if (typeof fromId !== "function") {
    throw new Error("Modal client does not support sandboxes.fromId");
  }
  return await fromId.call(client.sandboxes, sandboxId);
}

export async function readRemoteAgentsMd(sandboxId: string, tokenId: string, tokenSecret: string): Promise<string> {
  const client = new ModalClient({
    tokenId: process.env.MODAL_TOKEN_ID || tokenId,
    tokenSecret: process.env.MODAL_TOKEN_SECRET || tokenSecret,
  });

  const sandbox = await getSandboxById(client, sandboxId);

  const proc = await sandbox.exec(["/bin/sh", "-lc", "cat /home/ubuntu/.codex/AGENTS.md"], {
    workdir: "/",
    mode: "text",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.readText(),
    proc.stderr.readText(),
    proc.wait(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Failed to read AGENTS.md (exit ${exitCode}): ${stderr}`);
  }

  return stdout;
}

export async function cleanupCloudRun(sessionId: string, sandboxId: string, tokenId: string, tokenSecret: string): Promise<void> {
  const client = new ModalClient({
    tokenId: process.env.MODAL_TOKEN_ID || tokenId,
    tokenSecret: process.env.MODAL_TOKEN_SECRET || tokenSecret,
  });

  const sandbox = await getSandboxById(client, sandboxId);

  // Kill the agent process (SIGTERM to process group)
  try {
    await sandbox.exec(["/bin/sh", "-lc", "pkill -TERM -P 1 || true"], {
      workdir: "/",
      mode: "text",
    });
    await sleep(1000);
  } catch {
    // Ignore cleanup errors
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getTestFixtures(configPath: string): Promise<E2EFixtures> {
  const config = await loadE2EConfig(configPath);

  // Initialize DB connection - parse the SQLite URL
  const dbPath = parseSqliteFilePath(config.dbUrl, config.configDir);
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new Database(dbPath),
    }),
  });

  try {
    // Find first identity (any platform - github, slack, websocket, etc.)
    const identityRow = await db
      .selectFrom("identities")
      .select("id")
      .limit(1)
      .executeTakeFirst();

    if (!identityRow) {
      throw new Error("No identity found in database. Run tests with at least one identity configured.");
    }

    // Find first repo
    const repoRow = await db
      .selectFrom("repos")
      .select("id")
      .limit(1)
      .executeTakeFirst();

    const testRepoId = repoRow?.id ?? "";

    return {
      config,
      testIdentityId: identityRow.id,
      testRepoId,
    };
  } finally {
    await db.destroy();
  }
}

export async function createTestAuthToken(config: E2EConfig, identityId: string): Promise<string> {
  // Use the same token creation as cloud proxy
  return createProxyToken(
    config.proxySecret,
    identityId,
    24 * 60 * 60 * 1000 // 24 hours
  );
}

export async function readLocalAgentsMd(): Promise<string> {
  const agentsMdPath = path.resolve(process.cwd(), "AGENTS.md");
  return await readFile(agentsMdPath, "utf-8");
}

export async function readLocalPromptsFile(name: string): Promise<string> {
  const promptsPath = path.resolve(process.cwd(), "prompts", name);
  return await readFile(promptsPath, "utf-8");
}

export async function getSandboxIdByRunId(configPath: string, runId: string): Promise<string | null> {
  const config = await loadE2EConfig(configPath);

  // Initialize DB connection - parse the SQLite URL
  const dbPath = parseSqliteFilePath(config.dbUrl, config.configDir);
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new Database(dbPath),
    }),
  });

  try {
    const runRow = await db
      .selectFrom("cloud_runs")
      .select("workspace_id")
      .where("id", "=", runId)
      .executeTakeFirst();

    return runRow?.workspace_id ?? null;
  } finally {
    await db.destroy();
  }
}

/**
 * Set the user language preference in the database.
 * This is used to control which locale directive is included in AGENTS.md.
 */
export async function setUserLanguage(configPath: string, platform: string, userId: string, language: UserLanguage): Promise<void> {
  const config = await loadE2EConfig(configPath);

  // Initialize DB connection - parse the SQLite URL
  const dbPath = parseSqliteFilePath(config.dbUrl, config.configDir);
  const db = new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({
      database: new Database(dbPath),
    }),
  });

  try {
    const existing = await db
      .selectFrom("user_preferences")
      .select("id")
      .where("platform", "=", platform)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    const now = Math.floor(Date.now() / 1000);

    if (existing) {
      await db
        .updateTable("user_preferences")
        .set({ language, updated_at: now })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await db
        .insertInto("user_preferences")
        .values({
          id: randomUUID(),
          platform,
          user_id: userId,
          language,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  } finally {
    await db.destroy();
  }
}

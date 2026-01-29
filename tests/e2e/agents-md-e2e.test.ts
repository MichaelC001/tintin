import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import {
  getTestFixtures,
  WebSocketClient,
  readRemoteAgentsMd,
  cleanupCloudRun,
  type E2EConfig,
} from "../e2e/helpers.js";

const CONFIG_PATH = process.env.TINTIN_CONFIG ?? "./config.toml";

// Skip tests if config doesn't exist
if (!existsSync(CONFIG_PATH)) {
  console.log(`[SKIP] Config file not found: ${CONFIG_PATH}`);
  process.exit(0);
}

describe("E2E: AGENTS.md Prompts", () => {
  let config: E2EConfig;
  let ws: WebSocketClient;
  let sessionId: string | null;
  let sandboxId: string | null;
  let testIdentityId: string;
  let testRepoId: string;

  before(async () => {
    const fixtures = await getTestFixtures(CONFIG_PATH);
    config = fixtures.config;
    testIdentityId = fixtures.testIdentityId;
    testRepoId = fixtures.testRepoId;

    ws = new WebSocketClient(config.wsUrl);
    await ws.connect();
  });

  after(async () => {
    if (sessionId && sandboxId) {
      try {
        await cleanupCloudRun(sessionId, sandboxId, config.modalTokenId, config.modalTokenSecret);
      } catch (e) {
        console.error("[cleanup] Error:", e);
      }
    }
    if (ws) {
      ws.close();
    }
  });

  it("should include all prompts for English", async () => {
    sessionId = null;
    sandboxId = null;

    ws.send({
      type: "cloud_run",
      repoIds: [], // Empty list for minimal setup
      prompt: "Hello",
      language: "en",
    });

    // Wait for session_started
    const started = await ws.waitForMessage(
      (msg: any) => msg.type === "session_started",
      60000
    );

    assert.ok(started, "Should receive session_started message");
    sessionId = started.session_id ?? null;
    sandboxId = started.sandbox_id ?? null;

    assert.ok(sessionId, "Should have session_id");
    assert.ok(sandboxId, "Should have sandbox_id");

    // Read AGENTS.md from remote
    const agentsMd = await readRemoteAgentsMd(sandboxId, config.modalTokenId, config.modalTokenSecret);

    // Validate content
    assert.ok(agentsMd.includes("Tintin Developer Guide"), "Should include root AGENTS.md");
    assert.ok(
      agentsMd.includes("Code / Site / Deploy") || agentsMd.includes("INIT_REGISTER_DEPLOY"),
      "Should include prompts/INIT_REGISTER_DEPLOY.md content"
    );
    assert.ok(!agentsMd.includes("你必须用中文回答"), "Should NOT include Chinese locale directive");
  });

  it("should include Chinese locale directive for zh", async () => {
    sessionId = null;
    sandboxId = null;

    ws.send({
      type: "cloud_run",
      repoIds: [],
      prompt: "Hello",
      language: "zh",
    });

    const started = await ws.waitForMessage(
      (msg: any) => msg.type === "session_started",
      60000
    );

    assert.ok(started, "Should receive session_started message");
    sessionId = started.session_id ?? null;
    sandboxId = started.sandbox_id ?? null;

    assert.ok(sessionId, "Should have session_id");
    assert.ok(sandboxId, "Should have sandbox_id");

    const agentsMd = await readRemoteAgentsMd(sandboxId, config.modalTokenId, config.modalTokenSecret);

    assert.ok(agentsMd.includes("Tintin Developer Guide"), "Should include root AGENTS.md");
    assert.ok(
      agentsMd.includes("Code / Site / Deploy") || agentsMd.includes("INIT_REGISTER_DEPLOY"),
      "Should include prompts content"
    );
    assert.ok(agentsMd.includes("你必须用中文回答"), "Should include Chinese locale directive");
  });

  it("should have correct separator between sections", async () => {
    sessionId = null;
    sandboxId = null;

    ws.send({
      type: "cloud_run",
      repoIds: [],
      prompt: "Hello",
      language: "en",
    });

    const started = await ws.waitForMessage(
      (msg: any) => msg.type === "session_started",
      60000
    );

    assert.ok(started, "Should receive session_started message");
    sessionId = started.session_id ?? null;
    sandboxId = started.sandbox_id ?? null;

    assert.ok(sessionId, "Should have session_id");
    assert.ok(sandboxId, "Should have sandbox_id");

    const agentsMd = await readRemoteAgentsMd(sandboxId, config.modalTokenId, config.modalTokenSecret);

    // Check for separators between sections
    assert.ok(
      agentsMd.includes("\n\n---\n\n## From: prompts/") || agentsMd.includes("## From: prompts/"),
      "Should have separator before prompts or at least prompt headers"
    );
  });
});

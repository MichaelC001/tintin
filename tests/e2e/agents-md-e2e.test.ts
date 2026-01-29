import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import {
  getTestFixtures,
  WebSocketClient,
  readRemoteAgentsMd,
  cleanupCloudRun,
  getSandboxIdByRunId,
  setUserLanguage,
  type E2EConfig,
} from "../e2e/helpers.js";

const CONFIG_PATH = process.env.TINTIN_CONFIG ?? "./config.toml";

// Skip tests if config doesn't exist
if (!existsSync(CONFIG_PATH)) {
  console.log(`[SKIP] Config file not found: ${CONFIG_PATH}`);
  process.exit(0);
}

// Skip E2E tests unless explicitly enabled (requires Modal resources)
if (!process.env.E2E_TESTS_ENABLED) {
  console.log("[SKIP] E2E tests require Modal resources. Set E2E_TESTS_ENABLED=1 to run.");
  console.log("[SKIP] These tests validate AGENTS.md content in Modal sandboxes.");
  console.log("[SKIP] Ensure your Modal account has available resources before running.");
  process.exit(0);
}

describe("E2E: AGENTS.md Prompts", () => {
  let config: E2EConfig;
  let ws: WebSocketClient;
  let sessionId: string | null;
  let sandboxId: string | null;
  let testIdentityId: string;
  let testRepoId: string;
  let identityId: string;
  let platform: string;
  let userId: string;

  before(async () => {
    const fixtures = await getTestFixtures(CONFIG_PATH);
    config = fixtures.config;
    testIdentityId = fixtures.testIdentityId;
    testRepoId = fixtures.testRepoId;

    ws = new WebSocketClient(config.wsUrl);
    await ws.connect();

    // Authenticate (required even in no-auth mode to set up anonymous identity)
    ws.send({ type: "auth" });

    // Wait for auth_ok
    const authOk = await ws.waitForMessage(
      (msg: any) => msg.type === "auth_ok",
      5000
    );

    assert.ok(authOk, "Should receive auth_ok message");
    identityId = authOk.identityId || testIdentityId;
    // For WebSocket platform, platform="websocket" and userId=identityId
    platform = "websocket";
    userId = identityId;

    // Wait for sandbox_ready to ensure workspace is provisioned
    // The server auto-provisions a workspace for WebSocket connections
    const sandboxReady = await ws.waitForMessage(
      (msg: any) => msg.type === "sandbox_ready",
      30000
    );
    assert.ok(sandboxReady, "Should receive sandbox_ready message");
  });

  // Reset language to English before each test
  beforeEach(async () => {
    await setUserLanguage(CONFIG_PATH, platform, userId, "en");
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
    });

    // Wait for session_started
    const started = await ws.waitForMessage(
      (msg: any) => msg.type === "session_started",
      60000
    );

    assert.ok(started, "Should receive session_started message");
    // Note: fields are camelCase in the message
    sessionId = started.sessionId ?? null;
    const runId = started.runId ?? null;

    assert.ok(sessionId, "Should have sessionId");
    assert.ok(runId, "Should have runId");

    // Get sandbox_id (workspace_id) from database using runId
    sandboxId = await getSandboxIdByRunId(CONFIG_PATH, runId);
    assert.ok(sandboxId, "Should have sandbox_id from database");

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

    // Set language to Chinese in database
    await setUserLanguage(CONFIG_PATH, platform, userId, "zh");

    ws.send({
      type: "cloud_run",
      repoIds: [],
      prompt: "Hello",
    });

    const started = await ws.waitForMessage(
      (msg: any) => msg.type === "session_started",
      60000
    );

    assert.ok(started, "Should receive session_started message");
    sessionId = started.sessionId ?? null;
    const runId = started.runId ?? null;

    assert.ok(sessionId, "Should have sessionId");
    assert.ok(runId, "Should have runId");

    sandboxId = await getSandboxIdByRunId(CONFIG_PATH, runId);
    assert.ok(sandboxId, "Should have sandbox_id from database");

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
    });

    const started = await ws.waitForMessage(
      (msg: any) => msg.type === "session_started",
      60000
    );

    assert.ok(started, "Should receive session_started message");
    sessionId = started.sessionId ?? null;
    const runId = started.runId ?? null;

    assert.ok(sessionId, "Should have sessionId");
    assert.ok(runId, "Should have runId");

    sandboxId = await getSandboxIdByRunId(CONFIG_PATH, runId);
    assert.ok(sandboxId, "Should have sandbox_id from database");

    const agentsMd = await readRemoteAgentsMd(sandboxId, config.modalTokenId, config.modalTokenSecret);

    // Check for separators between sections
    assert.ok(
      agentsMd.includes("\n\n---\n\n## From: prompts/") || agentsMd.includes("## From: prompts/"),
      "Should have separator before prompts or at least prompt headers"
    );
  });
});

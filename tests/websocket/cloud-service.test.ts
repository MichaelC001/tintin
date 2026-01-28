import test from "node:test";
import assert from "node:assert/strict";
import { CloudRunService } from "../../src/runtime/websocket/services/cloud.js";
import type { CloudRunMessage, WSConnection, ServerMessage } from "../../src/runtime/websocket/types.js";
import type { Db } from "../../src/runtime/db.js";
import type { AppConfig } from "../../src/runtime/config.js";
import type { Logger } from "../../src/runtime/log.js";
import type { WebSocketManager } from "../../src/runtime/websocket/manager.js";
import type { CloudManager } from "../../src/runtime/cloud/manager.js";

// ============ Mock Factories ============

interface SentMessage {
  connId: string;
  message: ServerMessage;
}

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}

function createMockWsManager() {
  const sentMessages: SentMessage[] = [];
  const subscriptions: Array<{ connId: string; sessionId: string }> = [];

  return {
    sendToConnection: (connId: string, message: ServerMessage) => {
      sentMessages.push({ connId, message });
    },
    subscribeToSession: (connId: string, sessionId: string) => {
      subscriptions.push({ connId, sessionId });
    },
    _getSentMessages: () => sentMessages,
    _getSubscriptions: () => subscriptions,
  } as unknown as WebSocketManager & {
    _getSentMessages: () => SentMessage[];
    _getSubscriptions: () => Array<{ connId: string; sessionId: string }>;
  };
}

interface StartRunResult {
  runId: string;
  sessionId: string;
  cdpUrl: string | null;
}

function createMockCloudManager(result: Partial<StartRunResult> = {}) {
  const defaultResult: StartRunResult = {
    runId: "run-123",
    sessionId: "session-456",
    cdpUrl: null,
    ...result,
  };

  return {
    startRun: async () => defaultResult,
  } as unknown as CloudManager;
}

function createMockDb() {
  // Create a chainable mock that handles the Kysely query pattern
  const createChainableMock = (result: unknown) => ({
    selectAll: () => createChainableMock(result),
    select: () => createChainableMock(result),
    where: () => createChainableMock(result),
    executeTakeFirst: async () => result,
    execute: async () => (Array.isArray(result) ? result : []),
  });

  // Return identity with id for getOrCreateIdentity
  const identityResult = { id: "db-identity-123" };

  return {
    selectFrom: () => createChainableMock(identityResult),
    insertInto: () => ({
      values: () => ({
        execute: async () => {},
      }),
    }),
  } as unknown as Db;
}

function createMockConfig(): AppConfig {
  return {
    cloud: {
      default_agent: "codex",
      ui_base_url: "https://example.com",
    },
  } as unknown as AppConfig;
}

function createMockConnection(identityId = "ws-identity-123"): WSConnection {
  return {
    id: "conn-1",
    ws: {} as unknown,
    identityId,
    authenticated: true,
    subscribedSessions: new Set<string>(),
    lastPingAt: Date.now(),
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
    messageCount: 0,
  } as WSConnection;
}

// ============ Tests ============

test("CloudRunService handleCloudRun", async (t) => {
  await t.test("should send browser_session message when cdpUrl is available", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      runId: "run-abc",
      sessionId: "session-xyz",
      cdpUrl: "wss://hyperbrowser.example.com/cdp/123",
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const browserSessionMsg = sentMessages.find((m) => m.message.type === "browser_session");

    assert.ok(browserSessionMsg, "browser_session message should be sent");
    assert.equal(browserSessionMsg.connId, "conn-1");

    const msg = browserSessionMsg.message;
    assert.equal(msg.type, "browser_session");
    if (msg.type === "browser_session") {
      assert.equal(msg.sessionId, "session-xyz");
      assert.equal(msg.runId, "run-abc");
      assert.equal(msg.cdpUrl, "wss://hyperbrowser.example.com/cdp/123");
      assert.equal(msg.provider, "hyperbrowser");
    }
  });

  await t.test("should not send browser_session message when cdpUrl is null", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      runId: "run-abc",
      sessionId: "session-xyz",
      cdpUrl: null,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const browserSessionMsg = sentMessages.find((m) => m.message.type === "browser_session");

    assert.equal(browserSessionMsg, undefined, "browser_session message should not be sent");
  });

  await t.test("should send session_started message before browser_session", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      runId: "run-abc",
      sessionId: "session-xyz",
      cdpUrl: "wss://hyperbrowser.example.com/cdp/123",
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const sessionStartedIndex = sentMessages.findIndex((m) => m.message.type === "session_started");
    const browserSessionIndex = sentMessages.findIndex((m) => m.message.type === "browser_session");

    assert.ok(sessionStartedIndex >= 0, "session_started message should be sent");
    assert.ok(browserSessionIndex >= 0, "browser_session message should be sent");
    assert.ok(
      sessionStartedIndex < browserSessionIndex,
      "session_started should come before browser_session",
    );
  });

  await t.test("should return error when prompt is empty", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager();
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      prompt: "",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const errorMsg = sentMessages.find((m) => m.message.type === "error");

    assert.ok(errorMsg, "error message should be sent");
    if (errorMsg?.message.type === "error") {
      assert.equal(errorMsg.message.message, "Prompt is required");
    }
  });

  await t.test("should subscribe connection to session", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      runId: "run-abc",
      sessionId: "session-xyz",
      cdpUrl: null,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const subscriptions = wsManager._getSubscriptions();
    assert.equal(subscriptions.length, 1);
    const subscription = subscriptions[0];
    assert.ok(subscription, "subscription should exist");
    assert.equal(subscription.connId, "conn-1");
    assert.equal(subscription.sessionId, "session-xyz");
  });
});

test("mapDbStatusToWsStatus", async (t) => {
  // Import the function to test it directly
  const { mapDbStatusToWsStatus } = await import("../../src/runtime/cloud/types.js");

  await t.test("should map queued to queued", () => {
    assert.equal(mapDbStatusToWsStatus("queued"), "queued");
  });

  await t.test("should map running to running", () => {
    assert.equal(mapDbStatusToWsStatus("running"), "running");
  });

  await t.test("should map finished to finished", () => {
    assert.equal(mapDbStatusToWsStatus("finished"), "finished");
  });

  await t.test("should map error to error", () => {
    assert.equal(mapDbStatusToWsStatus("error"), "error");
  });

  await t.test("should map killed to error", () => {
    assert.equal(mapDbStatusToWsStatus("killed"), "error");
  });

  await t.test("should map unknown status to preparing", () => {
    assert.equal(mapDbStatusToWsStatus("unknown"), "preparing");
    assert.equal(mapDbStatusToWsStatus("anything"), "preparing");
  });
});

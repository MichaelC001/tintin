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

interface MockCloudManagerOptions {
  result?: Partial<StartRunResult>;
  detectLatestSnapshotResult?: string | null;
  startRunCapture?: Array<{ restoreSnapshotId: string | null }>;
  liveViewUrl?: string | null;
}

function createMockCloudManager(options: MockCloudManagerOptions = {}) {
  const defaultResult: StartRunResult = {
    runId: "run-123",
    sessionId: "session-456",
    cdpUrl: null,
    ...options.result,
  };

  const startRunCapture = options.startRunCapture ?? [];

  return {
    startRun: async (opts: { restoreSnapshotId?: string | null }) => {
      startRunCapture.push({ restoreSnapshotId: opts.restoreSnapshotId ?? null });
      return defaultResult;
    },
    detectLatestSnapshot: async () => options.detectLatestSnapshotResult ?? null,
    getLiveViewUrl: (sessionId: string) => {
      if (sessionId === defaultResult.sessionId) {
        return options.liveViewUrl ?? null;
      }
      return null;
    },
    _getStartRunCaptures: () => startRunCapture,
  } as unknown as CloudManager & {
    _getStartRunCaptures: () => Array<{ restoreSnapshotId: string | null }>;
  };
}

function createMockDb() {
  const identityResult = { id: "db-identity-123" };

  const createChainableMock = (table: string) => ({
    selectAll: () => createChainableMock(table),
    select: () => createChainableMock(table),
    where: () => createChainableMock(table),
    orderBy: () => createChainableMock(table),
    executeTakeFirst: async () => {
      if (table === "identities") return identityResult;
      if (table === "sessions") return null;
      return identityResult;
    },
    execute: async () => [],
  });

  return {
    selectFrom: (table: string) => createChainableMock(table),
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
    security: {
      max_sessions_per_identity: 1000,
      max_concurrent_sessions_per_identity: 100,
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

const baseChatId = "chat-123";

test("CloudRunService handleCloudRun", async (t) => {
  await t.test("should send browser_session message when cdpUrl is available", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      result: {
        runId: "run-abc",
        sessionId: "session-xyz",
        cdpUrl: "wss://hyperbrowser.example.com/cdp/123",
      },
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
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
      result: {
        runId: "run-abc",
        sessionId: "session-xyz",
        cdpUrl: null,
      },
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const browserSessionMsg = sentMessages.find((m) => m.message.type === "browser_session");

    assert.equal(browserSessionMsg, undefined, "browser_session message should not be sent");
  });

  await t.test("should send run_status(started) message before browser_session", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      result: {
        runId: "run-abc",
        sessionId: "session-xyz",
        cdpUrl: "wss://hyperbrowser.example.com/cdp/123",
      },
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const sessionStartedIndex = sentMessages.findIndex((m) => m.message.type === "run_status");
    const browserSessionIndex = sentMessages.findIndex((m) => m.message.type === "browser_session");

    assert.ok(sessionStartedIndex >= 0, "run_status(started) message should be sent");
    assert.ok(browserSessionIndex >= 0, "browser_session message should be sent");
    assert.ok(
      sessionStartedIndex < browserSessionIndex,
      "run_status(started) should come before browser_session",
    );
  });

  await t.test("should include liveViewUrl in browser_session message when available", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      result: {
        runId: "run-abc",
        sessionId: "session-xyz",
        cdpUrl: "wss://hyperbrowser.example.com/cdp/123",
      },
      liveViewUrl: "https://app.hyperbrowser.ai/live?token=abc123",
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const browserSessionMsg = sentMessages.find((m) => m.message.type === "browser_session");

    assert.ok(browserSessionMsg, "browser_session message should be sent");

    const msg = browserSessionMsg.message;
    assert.equal(msg.type, "browser_session");
    if (msg.type === "browser_session") {
      assert.equal(msg.liveViewUrl, "https://app.hyperbrowser.ai/live?token=abc123");
    }
  });

  await t.test("should not include liveViewUrl when not available", async () => {
    const wsManager = createMockWsManager();
    const cloudManager = createMockCloudManager({
      result: {
        runId: "run-abc",
        sessionId: "session-xyz",
        cdpUrl: "wss://hyperbrowser.example.com/cdp/123",
      },
      liveViewUrl: null,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Test prompt",
      repoIds: [],
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const sentMessages = wsManager._getSentMessages();
    const browserSessionMsg = sentMessages.find((m) => m.message.type === "browser_session");

    assert.ok(browserSessionMsg, "browser_session message should be sent");

    const msg = browserSessionMsg.message;
    assert.equal(msg.type, "browser_session");
    if (msg.type === "browser_session") {
      assert.equal(msg.liveViewUrl, undefined, "liveViewUrl should be undefined when not available");
    }
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
      chatId: baseChatId,
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
      result: {
        runId: "run-abc",
        sessionId: "session-xyz",
        cdpUrl: null,
      },
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
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

test("CloudRunService auto-restore", async (t) => {
  await t.test("should auto-restore when autoRestore=true and snapshot exists", async () => {
    const wsManager = createMockWsManager();
    const startRunCapture: Array<{ restoreSnapshotId: string | null }> = [];
    const cloudManager = createMockCloudManager({
      result: { runId: "run-abc", sessionId: "session-xyz", cdpUrl: null },
      detectLatestSnapshotResult: "snap-detected-123",
      startRunCapture,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Continue work",
      repoIds: [],
      autoRestore: true,
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const captures = cloudManager._getStartRunCaptures();
    assert.equal(captures.length, 1, "startRun should be called once");
    assert.equal(captures[0]?.restoreSnapshotId, "snap-detected-123", "should use detected snapshot");
  });

  await t.test("should not auto-restore when autoRestore=false", async () => {
    const wsManager = createMockWsManager();
    const startRunCapture: Array<{ restoreSnapshotId: string | null }> = [];
    const cloudManager = createMockCloudManager({
      result: { runId: "run-abc", sessionId: "session-xyz", cdpUrl: null },
      detectLatestSnapshotResult: "snap-should-not-use",
      startRunCapture,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Fresh start",
      repoIds: [],
      autoRestore: false,
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const captures = cloudManager._getStartRunCaptures();
    assert.equal(captures.length, 1, "startRun should be called once");
    assert.equal(captures[0]?.restoreSnapshotId, null, "should not use snapshot");
  });

  await t.test("should prefer explicit restoreSnapshotId over autoRestore", async () => {
    const wsManager = createMockWsManager();
    const startRunCapture: Array<{ restoreSnapshotId: string | null }> = [];
    const cloudManager = createMockCloudManager({
      result: { runId: "run-abc", sessionId: "session-xyz", cdpUrl: null },
      detectLatestSnapshotResult: "snap-auto-detected",
      startRunCapture,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Restore specific",
      repoIds: [],
      restoreSnapshotId: "snap-explicit-999",
      autoRestore: true,
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const captures = cloudManager._getStartRunCaptures();
    assert.equal(captures.length, 1, "startRun should be called once");
    assert.equal(captures[0]?.restoreSnapshotId, "snap-explicit-999", "should use explicit snapshot");
  });

  await t.test("should handle no snapshot found with autoRestore=true", async () => {
    const wsManager = createMockWsManager();
    const startRunCapture: Array<{ restoreSnapshotId: string | null }> = [];
    const cloudManager = createMockCloudManager({
      result: { runId: "run-abc", sessionId: "session-xyz", cdpUrl: null },
      detectLatestSnapshotResult: null, // No snapshot found
      startRunCapture,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Auto restore",
      repoIds: [],
      autoRestore: true,
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const captures = cloudManager._getStartRunCaptures();
    assert.equal(captures.length, 1, "startRun should be called once");
    assert.equal(captures[0]?.restoreSnapshotId, null, "should be null when no snapshot found");

    // Should still start session successfully
    const sentMessages = wsManager._getSentMessages();
    const sessionStartedMsg = sentMessages.find((m) => m.message.type === "run_status");
    assert.ok(sessionStartedMsg, "run_status(started) message should be sent");
  });

  await t.test("should not call detectLatestSnapshot when autoRestore is undefined", async () => {
    const wsManager = createMockWsManager();
    const startRunCapture: Array<{ restoreSnapshotId: string | null }> = [];
    const cloudManager = createMockCloudManager({
      result: { runId: "run-abc", sessionId: "session-xyz", cdpUrl: null },
      detectLatestSnapshotResult: "snap-should-not-use",
      startRunCapture,
    });
    const db = createMockDb();
    const config = createMockConfig();
    const logger = createMockLogger();

    const service = new CloudRunService(wsManager, cloudManager, config, db, logger);

    const message: CloudRunMessage = {
      type: "cloud_run",
      chatId: baseChatId,
      prompt: "Normal run",
      repoIds: [],
      // autoRestore not specified (undefined)
    };

    await service.handleCloudRun("conn-1", createMockConnection(), message);

    const captures = cloudManager._getStartRunCaptures();
    assert.equal(captures.length, 1, "startRun should be called once");
    assert.equal(captures[0]?.restoreSnapshotId, null, "should not use snapshot when autoRestore is undefined");
  });
});

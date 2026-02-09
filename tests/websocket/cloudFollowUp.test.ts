import test from "node:test";
import assert from "node:assert/strict";
import { CloudRunService } from "../../src/runtime/websocket/services/cloud.js";
import type { CloudFollowUpMessage, WSConnection, ServerMessage } from "../../src/runtime/websocket/types.js";
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
  const connections = new Map<string, WSConnection>();

  return {
    sendToConnection: (connId: string, message: ServerMessage) => {
      sentMessages.push({ connId, message });
    },
    subscribeToSession: (connId: string, sessionId: string) => {
      subscriptions.push({ connId, sessionId });
    },
    getConnection: (connId: string) => connections.get(connId),
    _getSentMessages: () => sentMessages,
    _getSubscriptions: () => subscriptions,
    _setConnection: (connId: string, conn: WSConnection) => connections.set(connId, conn),
  } as unknown as WebSocketManager & {
    _getSentMessages: () => SentMessage[];
    _getSubscriptions: () => Array<{ connId: string; sessionId: string }>;
    _setConnection: (connId: string, conn: WSConnection) => void;
  };
}

interface MockDbOptions {
  cloudRun?: {
    id: string;
    identity_id: string;
    session_id: string | null;
    status: string;
    provider: string;
    workspace_id: string;
  } | null;
  session?: {
    id: string;
    status: string;
    agent: string;
    codex_session_id: string | null;
    codex_cwd: string;
    project_id: string;
  } | null;
}

function createMockDb(opts: MockDbOptions = {}) {
  const cloudRun = opts.cloudRun ?? null;
  const session = opts.session ?? null;
  const identity = { id: "db-identity-123" };

  const createChainableMock = (table: string) => {
    const getResult = () => {
      if (table === "cloud_runs") return cloudRun;
      if (table === "sessions") return session;
      return identity;
    };
    return {
      selectAll: () => createChainableMock(table),
      select: () => createChainableMock(table),
      where: () => createChainableMock(table),
      executeTakeFirst: async () => getResult(),
      execute: async () => {
        const r = getResult();
        return r ? [r] : [];
      },
    };
  };

  return {
    selectFrom: (table: string) => createChainableMock(table),
    insertInto: () => ({
      values: () => ({
        execute: async () => {},
      }),
    }),
  } as unknown as Db;
}

function createMockCloudManager(overrides: Record<string, unknown> = {}) {
  return {
    startRun: async () => ({ runId: "run-123", sessionId: "session-456", cdpUrl: null }),
    detectLatestSnapshot: async () => null,
    resumeCloudSession: async () => "resumed" as const,
    restartCloudSession: async () => "restarted" as const,
    ...overrides,
  } as unknown as CloudManager;
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
    sandbox: null,
  } as WSConnection;
}

function makeFollowUpMessage(overrides: Partial<CloudFollowUpMessage> = {}): CloudFollowUpMessage {
  return {
    type: "cloud_follow_up",
    chatId: "chat-123",
    prompt: "Follow-up prompt",
    ...overrides,
  };
}

// ============ Tests ============

test("CloudRunService handleCloudFollowUp - parameter validation", async (t) => {
  await t.test("should return error when chatId is missing", async () => {
    const wsManager = createMockWsManager();
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), createMockDb(), createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage({ chatId: "" }),
    );

    const msgs = wsManager._getSentMessages();
    const err = msgs.find((m) => m.message.type === "error");
    assert.ok(err);
    if (err?.message.type === "error") {
      assert.equal(err.message.code, "INVALID_MESSAGE");
      assert.equal(err.message.message, "Chat ID required");
    }
  });

  await t.test("should return error when prompt is empty", async () => {
    const wsManager = createMockWsManager();
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), createMockDb(), createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage({ prompt: "" }),
    );

    const msgs = wsManager._getSentMessages();
    const err = msgs.find((m) => m.message.type === "error");
    assert.ok(err);
    if (err?.message.type === "error") {
      assert.equal(err.message.code, "INVALID_MESSAGE");
      assert.equal(err.message.message, "Prompt is required");
    }
  });

  await t.test("should return error when prompt is only whitespace", async () => {
    const wsManager = createMockWsManager();
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), createMockDb(), createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage({ prompt: "   " }),
    );

    const msgs = wsManager._getSentMessages();
    const err = msgs.find((m) => m.message.type === "error");
    assert.ok(err);
    if (err?.message.type === "error") {
      assert.equal(err.message.code, "INVALID_MESSAGE");
    }
  });
});

test("CloudRunService handleCloudFollowUp - ownership validation", async (t) => {
  await t.test("should return error when run does not exist for chat session", async () => {
    const wsManager = createMockWsManager();
    const db = createMockDb({
      cloudRun: null,
      session: {
        id: "session-456",
        status: "finished",
        agent: "codex",
        codex_session_id: "csid-1",
        codex_cwd: "/workspace",
        project_id: "cloud:test",
      },
    });
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    const msgs = wsManager._getSentMessages();
    const err = msgs.find((m) => m.message.type === "error");
    assert.ok(err);
    if (err?.message.type === "error") {
      assert.equal(err.message.code, "SESSION_NOT_FOUND");
      assert.equal(err.message.message, "Run not found for chat session");
    }
  });

  await t.test("should return error when identity does not match", async () => {
    const wsManager = createMockWsManager();
    const db = createMockDb({
      cloudRun: {
        id: "run-123",
        identity_id: "other-identity",
        session_id: "session-456",
        status: "finished",
        provider: "modal",
        workspace_id: "ws-1",
      },
      session: {
        id: "session-456",
        status: "finished",
        agent: "codex",
        codex_session_id: "csid-1",
        codex_cwd: "/workspace",
        project_id: "cloud:test",
      },
    });
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    const msgs = wsManager._getSentMessages();
    const err = msgs.find((m) => m.message.type === "error");
    assert.ok(err);
    if (err?.message.type === "error") {
      assert.equal(err.message.code, "ACCESS_DENIED");
    }
  });
});

test("CloudRunService handleCloudFollowUp - session status handling", async (t) => {
  const baseRun = {
    id: "run-123",
    identity_id: "db-identity-123",
    session_id: "session-456",
    status: "finished",
    provider: "modal",
    workspace_id: "ws-1",
  };

  const baseSession = {
    id: "session-456",
    status: "finished",
    agent: "codex",
    codex_session_id: "csid-1",
    codex_cwd: "/workspace",
    project_id: "cloud:test",
  };

  await t.test("should return error when run status is killed", async () => {
    const wsManager = createMockWsManager();
    const db = createMockDb({
      cloudRun: baseRun,
      session: { ...baseSession, status: "killed" },
    });
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    const msgs = wsManager._getSentMessages();
    const err = msgs.find((m) => m.message.type === "error");
    assert.ok(err);
    if (err?.message.type === "error") {
      assert.equal(err.message.code, "RUN_NOT_RESUMABLE");
    }
  });

  await t.test("should queue when session is running", async () => {
    const wsManager = createMockWsManager();
    const db = createMockDb({
      cloudRun: baseRun,
      session: { ...baseSession, status: "running" },
    });
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    const msgs = wsManager._getSentMessages();
    const queued = msgs.find((m) => m.message.type === "follow_up_status");
    assert.ok(queued, "should send follow_up_status");
    if (queued?.message.type === "follow_up_status") {
      assert.equal(queued.message.runId, "run-123");
      assert.equal(queued.message.sessionId, "session-456");
      assert.equal(queued.message.position, 1);
    }
  });

  await t.test("should queue when session is starting", async () => {
    const wsManager = createMockWsManager();
    const db = createMockDb({
      cloudRun: baseRun,
      session: { ...baseSession, status: "starting" },
    });
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    const msgs = wsManager._getSentMessages();
    const queued = msgs.find((m) => m.message.type === "follow_up_status");
    assert.ok(queued, "should send follow_up_status");
  });

  await t.test("should call resumeCloudSession when session is finished", async () => {
    const wsManager = createMockWsManager();
    let resumeCalled = false;
    const cloudManager = createMockCloudManager({
      resumeCloudSession: async () => {
        resumeCalled = true;
        return "resumed" as const;
      },
    });
    const db = createMockDb({
      cloudRun: baseRun,
      session: { ...baseSession, status: "finished" },
    });
    const service = new CloudRunService(
      wsManager, cloudManager, createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    assert.ok(resumeCalled, "resumeCloudSession should be called");
    const msgs = wsManager._getSentMessages();
    const resuming = msgs.find((m) => m.message.type === "follow_up_status");
    assert.ok(resuming, "should send follow_up_status");
    if (resuming?.message.type === "follow_up_status") {
      assert.equal(resuming.message.status, "resuming");
    }
  });

  await t.test("should call resumeCloudSession when session is error", async () => {
    const wsManager = createMockWsManager();
    let resumeCalled = false;
    const cloudManager = createMockCloudManager({
      resumeCloudSession: async () => {
        resumeCalled = true;
        return "resumed" as const;
      },
    });
    const db = createMockDb({
      cloudRun: baseRun,
      session: { ...baseSession, status: "error" },
    });
    const service = new CloudRunService(
      wsManager, cloudManager, createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    assert.ok(resumeCalled, "resumeCloudSession should be called");
  });

  await t.test("should fall back to restartCloudSession when sandbox expired", async () => {
    const wsManager = createMockWsManager();
    let restartCalled = false;
    const cloudManager = createMockCloudManager({
      resumeCloudSession: async () => "expired" as const,
      restartCloudSession: async () => {
        restartCalled = true;
        return "restarted" as const;
      },
    });
    const db = createMockDb({
      cloudRun: baseRun,
      session: { ...baseSession, status: "finished" },
    });
    const service = new CloudRunService(
      wsManager, cloudManager, createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    assert.ok(restartCalled, "restartCloudSession should be called");
    const msgs = wsManager._getSentMessages();
    const resuming = msgs.find((m) => m.message.type === "follow_up_status");
    assert.ok(resuming, "should send follow_up_status");
    if (resuming?.message.type === "follow_up_status") {
      assert.equal(resuming.message.status, "restarting");
    }
  });

  await t.test("should subscribe connection to session on follow-up", async () => {
    const wsManager = createMockWsManager();
    const db = createMockDb({
      cloudRun: baseRun,
      session: { ...baseSession, status: "finished" },
    });
    const service = new CloudRunService(
      wsManager, createMockCloudManager(), createMockConfig(), db, createMockLogger(),
    );

    await service.handleCloudFollowUp(
      "conn-1", createMockConnection(),
      makeFollowUpMessage(),
    );

    const subs = wsManager._getSubscriptions();
    assert.ok(subs.length > 0, "should subscribe to session");
    assert.equal(subs[0]?.sessionId, "session-456");
  });
});

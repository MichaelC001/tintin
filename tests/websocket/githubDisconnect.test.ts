import test from "node:test";
import assert from "node:assert/strict";
import { GitHubDisconnectService } from "../../src/runtime/websocket/services/githubDisconnect.js";
import type { GitHubDisconnectMessage, ServerMessage } from "../../src/runtime/websocket/types.js";
import type { Db } from "../../src/runtime/db.js";
import type { AppConfig } from "../../src/runtime/config.js";
import type { Logger } from "../../src/runtime/log.js";
import type { WebSocketManager } from "../../src/runtime/websocket/manager.js";

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

  return {
    sendToConnection: (connId: string, message: ServerMessage) => {
      sentMessages.push({ connId, message });
    },
    _getSentMessages: () => sentMessages,
    _clearMessages: () => {
      sentMessages.length = 0;
    },
  } as unknown as WebSocketManager & {
    _getSentMessages: () => SentMessage[];
    _clearMessages: () => void;
  };
}

function createMockConfig(cloudEnabled = true): AppConfig {
  return {
    cloud: cloudEnabled
      ? {
          enabled: true,
          secrets_key: "test-secret-key-for-encryption",
          ui: null,
        }
      : undefined,
  } as unknown as AppConfig;
}

interface MockDbOptions {
  connections?: Array<{
    id: string;
    identity_id: string;
    type: string;
  }> | null;
  repos?: Array<{ id: string }>;
  runs?: Array<{ id: string; session_id: string | null; status: string }>;
  pendingAction?: {
    id: string;
    payload_json: string;
    expires_at: number;
    consumed_at: number | null;
  } | null;
  connectionsById?: Record<string, {
    id: string;
    identity_id: string;
    type: string;
  }>;
}

function createMockDb(options: MockDbOptions = {}) {
  const connections = options.connections === null ? [] : (options.connections ?? [{
    id: "conn-123",
    identity_id: "identity-456",
    type: "github_oauth",
  }]);
  const repos = options.repos ?? [];
  const runs = options.runs ?? [];

  // Build connectionsById map for ID-based lookups
  const connectionsById = options.connectionsById ?? {};
  for (const conn of connections) {
    if (!connectionsById[conn.id]) {
      connectionsById[conn.id] = conn;
    }
  }

  // Track delete operations
  const deletedTables: string[] = [];
  const insertedTables: string[] = [];

  const createChainableMock = (tableName: string, result: unknown, whereClause?: { field: string; value: string }) => {
    let effectiveResult = result;

    // Handle where("id", "=", connectionId) pattern for connections table
    if (tableName === "connections" && whereClause?.field === "id" && connectionsById[whereClause.value]) {
      effectiveResult = connectionsById[whereClause.value];
    }

    return {
      selectAll: () => createChainableMock(tableName, effectiveResult, whereClause),
      select: () => createChainableMock(tableName, effectiveResult, whereClause),
      where: (field: string, op: string, value: string) => {
        // Capture where clause for ID-based lookups
        if (field === "id" && op === "=") {
          return createChainableMock(tableName, effectiveResult, { field, value });
        }
        return createChainableMock(tableName, effectiveResult, whereClause);
      },
      executeTakeFirst: async () => effectiveResult,
      execute: async () => (Array.isArray(effectiveResult) ? effectiveResult : effectiveResult ? [effectiveResult] : []),
    };
  };

  const createDeleteMock = (tableName: string) => ({
    where: () => createDeleteMock(tableName),
    execute: async () => {
      deletedTables.push(tableName);
      return { numDeletedRows: BigInt(1) };
    },
    executeTakeFirst: async () => {
      deletedTables.push(tableName);
      return { numDeletedRows: BigInt(1) };
    },
  });

  const createUpdateMock = (tableName: string) => ({
    set: () => createUpdateMock(tableName),
    where: () => createUpdateMock(tableName),
    execute: async () => ({ numUpdatedRows: BigInt(1) }),
  });

  const createInsertMock = (tableName: string) => ({
    values: () => ({
      execute: async () => {
        insertedTables.push(tableName);
      },
    }),
  });

  return {
    selectFrom: (tableName: string) => {
      if (tableName === "connections") {
        return createChainableMock(tableName, connections);
      }
      if (tableName === "repos") {
        return createChainableMock(tableName, repos);
      }
      if (tableName === "cloud_runs") {
        return createChainableMock(tableName, runs);
      }
      if (tableName === "cloud_run_repos") {
        return createChainableMock(tableName, []);
      }
      if (tableName === "cloud_run_screenshots") {
        return createChainableMock(tableName, []);
      }
      if (tableName === "cloud_snapshots") {
        return createChainableMock(tableName, []);
      }
      if (tableName === "session_stream_offsets") {
        return createChainableMock(tableName, []);
      }
      if (tableName === "identities") {
        return createChainableMock(tableName, { id: connections[0]?.identity_id ?? "identity-456" });
      }
      if (tableName === "pending_actions") {
        return createChainableMock(tableName, options.pendingAction);
      }
      return createChainableMock(tableName, null);
    },
    deleteFrom: (tableName: string) => createDeleteMock(tableName),
    updateTable: (tableName: string) => createUpdateMock(tableName),
    insertInto: (tableName: string) => createInsertMock(tableName),
    transaction: () => ({
      execute: async (fn: (trx: unknown) => Promise<void>) => {
        // Create a transaction mock that tracks operations
        const trxMock = {
          deleteFrom: (t: string) => createDeleteMock(t),
          updateTable: (t: string) => createUpdateMock(t),
          insertInto: (t: string) => createInsertMock(t),
        };
        await fn(trxMock);
      },
    }),
    _getDeletedTables: () => deletedTables,
    _getInsertedTables: () => insertedTables,
  } as unknown as Db & {
    _getDeletedTables: () => string[];
    _getInsertedTables: () => string[];
  };
}

// ============ Tests ============

test("GitHubDisconnectService", async (t) => {
  await t.test("should return error when cloud is not enabled", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(false);
    const db = createMockDb();
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    const message: GitHubDisconnectMessage = {
      type: "github_disconnect",
      action: "preview",
    };

    await service.handleGitHubDisconnect("conn-1", "identity-123", message);

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg0 = sentMessages[0];
    assert.ok(msg0);
    assert.equal(msg0.message.type, "github_disconnect_response");
    if (msg0.message.type === "github_disconnect_response") {
      assert.equal(msg0.message.error, "Cloud features not enabled");
    }
  });

  await t.test("should return error when no GitHub connection found", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(true);
    const db = createMockDb({ connections: null });
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    const message: GitHubDisconnectMessage = {
      type: "github_disconnect",
      action: "preview",
    };

    await service.handleGitHubDisconnect("conn-1", "identity-123", message);

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg1 = sentMessages[0];
    assert.ok(msg1);
    assert.equal(msg1.message.type, "github_disconnect_response");
    if (msg1.message.type === "github_disconnect_response") {
      assert.equal(msg1.message.error, "No GitHub connection found");
    }
  });

  await t.test("should return preview with impact and confirm token", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(true);
    const db = createMockDb({
      connections: [
        { id: "conn-123", identity_id: "identity-456", type: "github_oauth" },
      ],
      repos: [{ id: "repo-1" }, { id: "repo-2" }],
    });
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    const message: GitHubDisconnectMessage = {
      type: "github_disconnect",
      action: "preview",
    };

    await service.handleGitHubDisconnect("conn-1", "identity-456", message);

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg2 = sentMessages[0];
    assert.ok(msg2);
    assert.equal(msg2.message.type, "github_disconnect_response");

    if (msg2.message.type === "github_disconnect_response") {
      const msg = msg2.message;
      assert.equal(msg.impact!.repos, 2);
      assert.ok(msg.confirmToken, "confirmToken should be present");
      assert.equal(msg.expiresIn, 10 * 60 * 1000);
    }
  });

  await t.test("should return preview for github_app connection", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(true);
    const db = createMockDb({
      connections: [
        { id: "conn-456", identity_id: "identity-789", type: "github_app" },
      ],
      repos: [{ id: "repo-3" }],
    });
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    const message: GitHubDisconnectMessage = {
      type: "github_disconnect",
      action: "preview",
    };

    await service.handleGitHubDisconnect("conn-2", "identity-789", message);

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg = sentMessages[0];
    assert.ok(msg);
    assert.equal(msg.message.type, "github_disconnect_response");

    if (msg.message.type === "github_disconnect_response") {
      assert.equal(msg.message.impact!.repos, 1);
      assert.ok(msg.message.confirmToken, "confirmToken should be present");
      assert.equal(msg.message.expiresIn, 10 * 60 * 1000);
    }
  });

  await t.test("should return error when confirm token is missing", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(true);
    const db = createMockDb();
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    const message: GitHubDisconnectMessage = {
      type: "github_disconnect",
      action: "confirm",
      // token is missing
    };

    await service.handleGitHubDisconnect("conn-1", "identity-123", message);

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg3 = sentMessages[0];
    assert.ok(msg3);
    assert.equal(msg3.message.type, "github_disconnect_response");
    if (msg3.message.type === "github_disconnect_response") {
      assert.equal(msg3.message.error, "Missing confirmation token");
    }
  });

  await t.test("should return error when confirm token is invalid", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(true);
    const db = createMockDb({ pendingAction: null }); // No pending action found
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    const message: GitHubDisconnectMessage = {
      type: "github_disconnect",
      action: "confirm",
      token: "invalid-token",
    };

    await service.handleGitHubDisconnect("conn-1", "identity-123", message);

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg4 = sentMessages[0];
    assert.ok(msg4);
    assert.equal(msg4.message.type, "github_disconnect_response");
    if (msg4.message.type === "github_disconnect_response") {
      assert.equal(msg4.message.error, "Invalid or expired confirmation token");
    }
  });

  await t.test("should return preview covering both github_app and github_oauth connections", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(true);
    const db = createMockDb({
      connections: [
        { id: "conn-app", identity_id: "identity-456", type: "github_app" },
        { id: "conn-oauth", identity_id: "identity-456", type: "github_oauth" },
      ],
      repos: [{ id: "repo-1" }, { id: "repo-2" }],
    });
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    await service.handleGitHubDisconnect("conn-1", "identity-456", {
      type: "github_disconnect",
      action: "preview",
    });

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg = sentMessages[0]!;
    assert.equal(msg.message.type, "github_disconnect_response");
    if (msg.message.type === "github_disconnect_response") {
      assert.ok(msg.message.confirmToken, "should have confirm token");
      assert.equal(msg.message.impact!.repos, 2);
    }
  });

  await t.test("should return error for invalid action", async () => {
    const wsManager = createMockWsManager();
    const config = createMockConfig(true);
    const db = createMockDb();
    const logger = createMockLogger();

    const service = new GitHubDisconnectService(wsManager, config, db, logger, null);

    const message = {
      type: "github_disconnect",
      action: "invalid_action",
    } as unknown as GitHubDisconnectMessage;

    await service.handleGitHubDisconnect("conn-1", "identity-123", message);

    const sentMessages = wsManager._getSentMessages();
    assert.equal(sentMessages.length, 1);
    const msg5 = sentMessages[0];
    assert.ok(msg5);
    assert.equal(msg5.message.type, "github_disconnect_response");
    if (msg5.message.type === "github_disconnect_response") {
      assert.equal(msg5.message.error, "Invalid action");
    }
  });
});

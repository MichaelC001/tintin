import test from "node:test";
import assert from "node:assert/strict";

// We test resolveProviderConfig indirectly via startOAuthFlow,
// since resolveProviderConfig is not exported.
// The test verifies that startOAuthFlow works when only cloud.github_app
// has client_id/client_secret (no cloud.oauth.github configured).

import { startOAuthFlow } from "../../src/runtime/cloud/oauth.js";
import type { CloudSection } from "../../src/runtime/config.js";
import type { Db } from "../../src/runtime/db.js";

function createMockDb(): Db {
  const insertedRows: Array<{ table: string; values: unknown }> = [];
  return {
    insertInto: (table: string) => ({
      values: (values: unknown) => ({
        execute: async () => {
          insertedRows.push({ table, values });
        },
      }),
    }),
    _getInserted: () => insertedRows,
  } as unknown as Db & { _getInserted: () => Array<{ table: string; values: unknown }> };
}

test("resolveProviderConfig fallback to github_app", async (t) => {
  await t.test("startOAuthFlow resolves github provider from github_app config", async () => {
    const db = createMockDb();
    const cloud: CloudSection = {
      enabled: true,
      provider: "local",
      public_base_url: "https://app.example.com",
      log_relay_enabled: false,
      workspaces_dir: "/tmp",
      default_agent: "codex",
      secrets_key: "test-key",
      keepalive_minutes: 10,
      oauth: { callback_path: "/oauth/callback" },
      github_app: {
        app_id: "12345",
        app_slug: "test-app",
        private_key: "",
        api_base_url: "https://api.github.com",
        app_base_url: "https://github.com",
        webhook_path: "/github/webhook",
        webhook_secret: "secret",
        client_id: "Iv1.test123",
        client_secret: "secret123",
      },
    } as unknown as CloudSection;

    const result = await startOAuthFlow({
      db,
      cloud,
      provider: "github",
      identityId: "id-1",
      redirectBase: "https://app.example.com",
    });

    assert.ok(result.authorizeUrl, "should return authorizeUrl");
    assert.ok(
      result.authorizeUrl.startsWith("https://github.com/login/oauth/authorize"),
      `authorizeUrl should use app_base_url, got: ${result.authorizeUrl}`,
    );
    assert.ok(
      result.authorizeUrl.includes("client_id=Iv1.test123"),
      "authorizeUrl should contain client_id from github_app config",
    );
  });

  await t.test("startOAuthFlow throws when no github config at all", async () => {
    const db = createMockDb();
    const cloud: CloudSection = {
      enabled: true,
      provider: "local",
      public_base_url: "https://app.example.com",
      log_relay_enabled: false,
      workspaces_dir: "/tmp",
      default_agent: "codex",
      secrets_key: "test-key",
      keepalive_minutes: 10,
      oauth: { callback_path: "/oauth/callback" },
      // No github_app, no oauth.github
    } as unknown as CloudSection;

    await assert.rejects(
      () => startOAuthFlow({
        db,
        cloud,
        provider: "github",
        identityId: "id-1",
        redirectBase: "https://app.example.com",
      }),
      /OAuth provider not configured/,
    );
  });

  await t.test("explicit oauth.github takes precedence over github_app", async () => {
    const db = createMockDb();
    const cloud: CloudSection = {
      enabled: true,
      provider: "local",
      public_base_url: "https://app.example.com",
      log_relay_enabled: false,
      workspaces_dir: "/tmp",
      default_agent: "codex",
      secrets_key: "test-key",
      keepalive_minutes: 10,
      oauth: {
        callback_path: "/oauth/callback",
        github: {
          client_id: "explicit-id",
          client_secret: "explicit-secret",
          authorize_url: "https://github.com/login/oauth/authorize",
          token_url: "https://github.com/login/oauth/access_token",
          api_base_url: "https://api.github.com",
          scopes: ["repo"],
        },
      },
      github_app: {
        app_id: "12345",
        app_slug: "test-app",
        private_key: "",
        api_base_url: "https://api.github.com",
        app_base_url: "https://github.com",
        webhook_path: "/github/webhook",
        webhook_secret: "secret",
        client_id: "Iv1.app-id",
        client_secret: "app-secret",
      },
    } as unknown as CloudSection;

    const result = await startOAuthFlow({
      db,
      cloud,
      provider: "github",
      identityId: "id-1",
      redirectBase: "https://app.example.com",
    });

    assert.ok(
      result.authorizeUrl.includes("client_id=explicit-id"),
      "should use explicit oauth.github config, not github_app",
    );
  });
});

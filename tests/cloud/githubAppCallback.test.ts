import test from "node:test";
import assert from "node:assert/strict";
import { handleGithubAppCallback } from "../../src/runtime/cloud/githubApp.js";
import type { CloudSection } from "../../src/runtime/config.js";
import type { Db } from "../../src/runtime/db.js";

// Minimal mock DB that satisfies the callback flow
function createMockDb(opts: {
  oauthState?: { identity_id: string; metadata_json: string | null; code_verifier: string; redirect_url: string };
}) {
  const state = opts.oauthState ?? {
    identity_id: "id-1",
    metadata_json: JSON.stringify({ connection_id: "ws-conn-1" }),
    code_verifier: "verifier",
    redirect_url: "https://app.example.com/oauth/callback",
  };
  const insertedTables: string[] = [];
  const deletedTables: string[] = [];

  return {
    selectFrom: (table: string) => ({
      selectAll: () => ({
        where: () => ({
          where: () => ({
            executeTakeFirst: async () => {
              // oauth_states lookup
              return {
                id: "state-1",
                identity_id: state.identity_id,
                metadata_json: state.metadata_json,
                code_verifier: state.code_verifier,
                redirect_url: state.redirect_url,
                expires_at: Date.now() + 600_000,
              };
            },
          }),
          executeTakeFirst: async () => null,
          execute: async () => [],
        }),
        executeTakeFirst: async () => null,
      }),
      select: (..._cols: unknown[]) => {
        const chainable: any = {
          where: () => chainable,
          executeTakeFirst: async () => null,
          execute: async () => [],
        };
        return chainable;
      },
    }),
    insertInto: (t: string) => ({
      values: (_values: unknown) => ({
        execute: async () => { insertedTables.push(t); },
        onConflict: () => ({
          doUpdateSet: () => ({
            execute: async () => { insertedTables.push(t); },
          }),
        }),
      }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({
          execute: async () => {},
        }),
      }),
    }),
    deleteFrom: (table: string) => ({
      where: () => ({
        execute: async () => { deletedTables.push(table); },
      }),
    }),
    _getInserted: () => insertedTables,
    _getDeleted: () => deletedTables,
  } as unknown as Db;
}

// Mock fetch for GitHub API calls in handleGithubAppCallback
function mockGlobalFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    // Installation info
    if (urlStr.includes("/app/installations/") && !urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({
        account: { login: "test-org", type: "Organization" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Installation access token
    if (urlStr.includes("access_tokens")) {
      return new Response(JSON.stringify({
        token: "ghs_test_token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("handleGithubAppCallback", async (t) => {
  await t.test("returns oauthRedirectUrl when client_id/client_secret configured", async () => {
    const restore = mockGlobalFetch();
    try {
      const db = createMockDb({});
      const cloud = {
        enabled: true,
        public_base_url: "https://app.example.com",
        secrets_key: "0123456789abcdef0123456789abcdef",
        oauth: { callback_path: "/oauth/callback" },
        github_app: {
          app_id: "12345",
          app_slug: "test-app",
          private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC5/iTMHyr0Yc72\nfZRiTFV7IksXL5sLQaKDkUwSpjNpbb+rbd0JS5m/fW4KD1tVrk/frWNXa/6yPTZN\ndspKdo+FsKiJlNIGuSZmHjE3QRTaw23AXXlpJ9huiL2BYhSUMrRA6BXuIIVMaWBd\nC+g3iOV0ki9L1WKvyl5V1D8rKsATGAkeXJ21lQjEhIEZCeSoZAZLERmZRQwLH3pB\ny2Ss54qih0Uda8nQJS8p7P40Z4YH3hg+CJ16ZGCL+9Y2QW++e/6wTPO1bKv6RlWc\nAkPQzw56/qjMVxpfH98HlAPx9YDRl4edwL/8oMjgo9OEHteICqtvjsfSjVgPjOWI\n9UcARWOZAgMBAAECggEAAhQFwTxrWQX9nSrmDURFqD7aIs0LX+LTATAzSkMy3iZs\npGqWIfi9/1adc92cD/AriXNuz03Uwd48qDztj3ADIfXbp6ucB3RYc36DcSAKd+Yo\n1lrZmU0yrQvKq24ARW+l42TrV4as7XsTYEkRfS+nQvzCmfV2ba/Y5pHBavAPooJk\ndxct9dMXYjYVq4SaagznygGy1E0HB463l48tepuuVh1QR8jhUbic8tU3pLR5ts11\nR6DeqXdg2/LfVavbilqMzjrHSdRSwxzwTf5P3YWsmqPaKeUEOwOc5E/pWS8oWiwo\nSsQHzbUWzt+UOaDqesVkR1X6ESaVUzXv8hHB9coMaQKBgQD6KC9zkuKQHntUj2V0\nwggO1Bs8qaC9212upmY7CuqEd/blleY3gigwfGqwphhWwdYHB0fndwhx+6BnYYY5\nb58m4InbbtIW+hl5vI7TIdInnsbSJ619Sy86w+imbAwmKaPCzPvGPRsRXCSlZ1zh\netE4F/v44YGbo1ZO/gGWz0WxOwKBgQC+VknDZ4xknbtOiXJrYFq5aw2+Eo0RJ0Fx\nhA2aE3MOIOXVtNzIbkYst70q0uMqId0WuiV9wuumSLwrnpPVjCi/kS5WfXm2qJUj\n9k7usaVcNnPjBG/v+FPCJ9IjgfBoeW2p0vQ4kPbnX+d5M6GpQE9B8gDJ2lhHobVv\nSVUp6EfxOwKBgBf6hiHj8Ie0BEpkvGrmtnMFbd7wu5G3V1GIbcA3Gae9ABOdvMWR\nWlzbcDailS6rweJGlmPfixWx8vw14vHaezz0xQIdq1G8g3ih1Gb0lPprQ8+dMgoS\njOJrKP/a14dI8oOXtoKYFOIjHPgl4kdSyH9B/UssAopyq7FCs9BK6flFAoGAK33O\nBw9fHhKInS587ZorwNh8YGUexL+ijYyuCvnMvXq46bcVB9tiv48Qc3uSmqr4ONw5\n+t2SOQG/tXvbrd0D5poG645qRFmLEpeSe6ot7b8nhcUaysuEYAX3V1O2mji83SQt\n18sQD9hzLNemZeUi9x+UHIt+xodlzNMF2biQz8cCgYEAo0GJLLzyw4eDYH8WvowR\nrCuSqEj54UqVACgleWPsKG9eL/qLfbvZvuscOeyRp1kPk2qOwYosD83kgwliesc2\nFzLW47k4ifv+gmdRAaiuUd2ns9qVj2W31McsT7h7gd5RWL/hH9TtHjoYkzRS34nV\ni2Pa6ZvqHVqMfVCuYMKkRks=\n-----END PRIVATE KEY-----",
          api_base_url: "https://api.github.com",
          app_base_url: "https://github.com",
          webhook_path: "/github/webhook",
          webhook_secret: "secret",
          client_id: "Iv1.test123",
          client_secret: "secret123",
        },
      } as unknown as CloudSection;

      const result = await handleGithubAppCallback({
        db,
        cloud,
        installationId: "999",
        state: "test-state",
      });

      assert.equal(result.provider, "github");
      assert.equal(result.identityId, "id-1");
      assert.ok(result.oauthRedirectUrl, "oauthRedirectUrl should be present");
      assert.ok(
        result.oauthRedirectUrl!.startsWith("https://github.com/login/oauth/authorize"),
        `should redirect to GitHub OAuth, got: ${result.oauthRedirectUrl}`,
      );
      assert.ok(
        result.oauthRedirectUrl!.includes("client_id=Iv1.test123"),
        "redirect URL should contain client_id",
      );
    } finally {
      restore();
    }
  });

  await t.test("returns null oauthRedirectUrl when client_id not configured", async () => {
    const restore = mockGlobalFetch();
    try {
      const db = createMockDb({});
      const cloud = {
        enabled: true,
        public_base_url: "https://app.example.com",
        secrets_key: "0123456789abcdef0123456789abcdef",
        oauth: { callback_path: "/oauth/callback" },
        github_app: {
          app_id: "12345",
          app_slug: "test-app",
          private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC5/iTMHyr0Yc72\nfZRiTFV7IksXL5sLQaKDkUwSpjNpbb+rbd0JS5m/fW4KD1tVrk/frWNXa/6yPTZN\ndspKdo+FsKiJlNIGuSZmHjE3QRTaw23AXXlpJ9huiL2BYhSUMrRA6BXuIIVMaWBd\nC+g3iOV0ki9L1WKvyl5V1D8rKsATGAkeXJ21lQjEhIEZCeSoZAZLERmZRQwLH3pB\ny2Ss54qih0Uda8nQJS8p7P40Z4YH3hg+CJ16ZGCL+9Y2QW++e/6wTPO1bKv6RlWc\nAkPQzw56/qjMVxpfH98HlAPx9YDRl4edwL/8oMjgo9OEHteICqtvjsfSjVgPjOWI\n9UcARWOZAgMBAAECggEAAhQFwTxrWQX9nSrmDURFqD7aIs0LX+LTATAzSkMy3iZs\npGqWIfi9/1adc92cD/AriXNuz03Uwd48qDztj3ADIfXbp6ucB3RYc36DcSAKd+Yo\n1lrZmU0yrQvKq24ARW+l42TrV4as7XsTYEkRfS+nQvzCmfV2ba/Y5pHBavAPooJk\ndxct9dMXYjYVq4SaagznygGy1E0HB463l48tepuuVh1QR8jhUbic8tU3pLR5ts11\nR6DeqXdg2/LfVavbilqMzjrHSdRSwxzwTf5P3YWsmqPaKeUEOwOc5E/pWS8oWiwo\nSsQHzbUWzt+UOaDqesVkR1X6ESaVUzXv8hHB9coMaQKBgQD6KC9zkuKQHntUj2V0\nwggO1Bs8qaC9212upmY7CuqEd/blleY3gigwfGqwphhWwdYHB0fndwhx+6BnYYY5\nb58m4InbbtIW+hl5vI7TIdInnsbSJ619Sy86w+imbAwmKaPCzPvGPRsRXCSlZ1zh\netE4F/v44YGbo1ZO/gGWz0WxOwKBgQC+VknDZ4xknbtOiXJrYFq5aw2+Eo0RJ0Fx\nhA2aE3MOIOXVtNzIbkYst70q0uMqId0WuiV9wuumSLwrnpPVjCi/kS5WfXm2qJUj\n9k7usaVcNnPjBG/v+FPCJ9IjgfBoeW2p0vQ4kPbnX+d5M6GpQE9B8gDJ2lhHobVv\nSVUp6EfxOwKBgBf6hiHj8Ie0BEpkvGrmtnMFbd7wu5G3V1GIbcA3Gae9ABOdvMWR\nWlzbcDailS6rweJGlmPfixWx8vw14vHaezz0xQIdq1G8g3ih1Gb0lPprQ8+dMgoS\njOJrKP/a14dI8oOXtoKYFOIjHPgl4kdSyH9B/UssAopyq7FCs9BK6flFAoGAK33O\nBw9fHhKInS587ZorwNh8YGUexL+ijYyuCvnMvXq46bcVB9tiv48Qc3uSmqr4ONw5\n+t2SOQG/tXvbrd0D5poG645qRFmLEpeSe6ot7b8nhcUaysuEYAX3V1O2mji83SQt\n18sQD9hzLNemZeUi9x+UHIt+xodlzNMF2biQz8cCgYEAo0GJLLzyw4eDYH8WvowR\nrCuSqEj54UqVACgleWPsKG9eL/qLfbvZvuscOeyRp1kPk2qOwYosD83kgwliesc2\nFzLW47k4ifv+gmdRAaiuUd2ns9qVj2W31McsT7h7gd5RWL/hH9TtHjoYkzRS34nV\ni2Pa6ZvqHVqMfVCuYMKkRks=\n-----END PRIVATE KEY-----",
          api_base_url: "https://api.github.com",
          app_base_url: "https://github.com",
          webhook_path: "/github/webhook",
          webhook_secret: "secret",
          client_id: "",     // empty = not configured
          client_secret: "",
        },
      } as unknown as CloudSection;

      const result = await handleGithubAppCallback({
        db,
        cloud,
        installationId: "999",
        state: "test-state",
      });

      assert.equal(result.oauthRedirectUrl, null, "oauthRedirectUrl should be null");
    } finally {
      restore();
    }
  });
});

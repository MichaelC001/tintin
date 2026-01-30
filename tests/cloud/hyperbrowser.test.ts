import { describe, it } from "node:test";
import assert from "node:assert";
import { parseSessionResponse, type HyperbrowserSessionInfo } from "../../src/runtime/cloud/hyperbrowser.js";

describe("hyperbrowser", () => {
  describe("parseSessionResponse", () => {
    it("should parse id, wsEndpoint, and liveUrl correctly", () => {
      const payload = {
        id: "session-123",
        wsEndpoint: "wss://connect.hyperbrowser.ai/devtools/browser/abc",
        liveUrl: "https://app.hyperbrowser.ai/live?token=xyz",
      };

      const result = parseSessionResponse(payload);

      assert.strictEqual(result.id, "session-123");
      assert.strictEqual(result.wsEndpoint, "wss://connect.hyperbrowser.ai/devtools/browser/abc");
      assert.strictEqual(result.liveUrl, "https://app.hyperbrowser.ai/live?token=xyz");
    });

    it("should parse alternative field names (sessionId, ws_endpoint, live_url)", () => {
      const payload = {
        sessionId: "session-456",
        ws_endpoint: "wss://connect.hyperbrowser.ai/devtools/browser/def",
        live_url: "https://app.hyperbrowser.ai/live?token=abc",
      };

      const result = parseSessionResponse(payload);

      assert.strictEqual(result.id, "session-456");
      assert.strictEqual(result.wsEndpoint, "wss://connect.hyperbrowser.ai/devtools/browser/def");
      assert.strictEqual(result.liveUrl, "https://app.hyperbrowser.ai/live?token=abc");
    });

    it("should return null for liveUrl when not present", () => {
      const payload = {
        id: "session-789",
        wsEndpoint: "wss://connect.hyperbrowser.ai/devtools/browser/ghi",
      };

      const result = parseSessionResponse(payload);

      assert.strictEqual(result.id, "session-789");
      assert.strictEqual(result.wsEndpoint, "wss://connect.hyperbrowser.ai/devtools/browser/ghi");
      assert.strictEqual(result.liveUrl, null);
    });

    it("should prefer liveUrl over live_url when both present", () => {
      const payload = {
        id: "session-001",
        wsEndpoint: "wss://connect.hyperbrowser.ai/devtools/browser/jkl",
        liveUrl: "https://app.hyperbrowser.ai/live?token=primary",
        live_url: "https://app.hyperbrowser.ai/live?token=fallback",
      };

      const result = parseSessionResponse(payload);

      assert.strictEqual(result.liveUrl, "https://app.hyperbrowser.ai/live?token=primary");
    });

    it("should throw when payload is not an object", () => {
      assert.throws(() => parseSessionResponse(null), {
        message: "Hyperbrowser session response is not an object",
      });

      assert.throws(() => parseSessionResponse("string"), {
        message: "Hyperbrowser session response is not an object",
      });

      assert.throws(() => parseSessionResponse(undefined), {
        message: "Hyperbrowser session response is not an object",
      });
    });

    it("should throw when id is missing", () => {
      const payload = {
        wsEndpoint: "wss://connect.hyperbrowser.ai/devtools/browser/abc",
      };

      assert.throws(() => parseSessionResponse(payload), {
        message: "Hyperbrowser session response missing id/wsEndpoint",
      });
    });

    it("should throw when wsEndpoint is missing", () => {
      const payload = {
        id: "session-123",
      };

      assert.throws(() => parseSessionResponse(payload), {
        message: "Hyperbrowser session response missing id/wsEndpoint",
      });
    });
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildLocalizedPrompt } from "../../src/runtime/prompt.js";

describe("buildLocalizedPrompt", () => {
  it("should return the base prompt unchanged", () => {
    const result = buildLocalizedPrompt("base prompt", "en");

    assert.strictEqual(result, "base prompt");
  });

  it("should ignore search directive (now in AGENTS.md)", () => {
    const result = buildLocalizedPrompt("base prompt", "en", {
      searchDirective: "Search for things",
    });

    assert.strictEqual(result, "base prompt");
  });

  it("should ignore language parameter (now in AGENTS.md)", () => {
    const result = buildLocalizedPrompt("base prompt", "zh");

    assert.strictEqual(result, "base prompt");
  });

  it("should handle empty string", () => {
    const result = buildLocalizedPrompt("", "en");

    assert.strictEqual(result, "");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildLocalizedPrompt } from "../../src/runtime/prompt.js";

describe("buildLocalizedPrompt", () => {
  it("should include search directive when provided", () => {
    const result = buildLocalizedPrompt("base prompt", "en", {
      searchDirective: "Search for things",
    });

    assert.ok(result.includes("Search for things"));
    assert.ok(result.includes("base prompt"));
  });

  it("should work without search directive", () => {
    const result = buildLocalizedPrompt("base prompt", "en");

    assert.ok(result.includes("base prompt"));
  });

  it("should include language directive", () => {
    const result = buildLocalizedPrompt("base prompt", "zh");

    assert.ok(result.includes("你必须用中文回答"));
    assert.ok(result.includes("base prompt"));
  });
});

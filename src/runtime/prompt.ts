import type { UserLanguage } from "../locales/index.js";

export function buildLocalizedPrompt(
  prompt: string,
  _lang: UserLanguage,
  _opts?: { searchDirective?: string | null },
): string {
  // Language and search directives are now in ~/.codex/AGENTS.md
  return typeof prompt === "string" ? prompt : "";
}

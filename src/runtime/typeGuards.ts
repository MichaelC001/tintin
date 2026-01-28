/**
 * Type guard utilities for runtime type checking.
 * Centralizes common type guards to eliminate duplication across modules.
 */

/**
 * Type guard to check if a value is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts a non-empty string from an unknown value.
 * Returns null if the value is not a string or is empty after trimming.
 */
export function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Extracts a finite number from an unknown value.
 * Returns null if the value is not a number or is NaN/Infinity.
 */
export function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extracts a boolean from an unknown value.
 * Returns null if the value is not a boolean.
 */
export function getBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

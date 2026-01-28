/**
 * Unified cloud run status types.
 * Database uses a core subset; WebSocket uses extended set for UI granularity.
 */

/**
 * Core status values stored in the database.
 * These represent the fundamental execution states.
 */
export type CloudRunDbStatus = "queued" | "running" | "finished" | "error" | "killed";

/**
 * Extended status values sent over WebSocket.
 * Includes intermediate states for better UI feedback.
 */
export type CloudRunWsStatus =
  | "queued"
  | "preparing"
  | "cloning"
  | "setting_up"
  | "running"
  | "finished"
  | "error";

/**
 * Maps a database status to its WebSocket equivalent.
 * Terminal states (error, killed) map to 'error'.
 * Unknown states default to 'preparing'.
 */
export function mapDbStatusToWsStatus(dbStatus: CloudRunDbStatus | string): CloudRunWsStatus {
  switch (dbStatus) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "finished":
      return "finished";
    case "error":
    case "killed":
      return "error";
    default:
      return "preparing";
  }
}

/**
 * Browser session provider types.
 */
export type BrowserProvider = "browserbase" | "hyperbrowser";

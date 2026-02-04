/**
 * Shared cleanup logic for GitHub disconnect flows.
 *
 * Both github_app (TG/Slack) and github_oauth (WebSocket) disconnects
 * follow the same pattern: load scope → stop sandboxes → transactional
 * delete → external file cleanup. This module extracts the common parts.
 */

import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Transaction } from "kysely";
import type { CloudUiSection } from "../config.js";
import type { Db, DatabaseSchema } from "../db.js";
import type { Logger } from "../log.js";
import { nowMs } from "../util.js";
import type { CloudManager } from "./manager.js";
import { deleteS3Object } from "./s3.js";

// ============================================================================
// Types
// ============================================================================

export interface DisconnectScope {
  connectionIds: string[];
  identityIds: string[];
  repoIds: string[];
  runIds: string[];
  sessionIds: string[];
  jsonlPaths: string[];
  screenshotKeys: string[];
  snapshotIds: string[];
}

export interface DisconnectImpact {
  repos: number;
  runs: number;
  sessions: number;
  screenshots: number;
  snapshots: number;
}

// ============================================================================
// Scope Loading
// ============================================================================

/**
 * Load all data related to a set of connection IDs for cleanup.
 * Shared entry point for both TG (multiple connections) and OAuth (single connection).
 */
export async function loadDisconnectScope(
  db: Db,
  connectionIds: string[],
): Promise<DisconnectScope> {
  if (connectionIds.length === 0) {
    return {
      connectionIds: [],
      identityIds: [],
      repoIds: [],
      runIds: [],
      sessionIds: [],
      jsonlPaths: [],
      screenshotKeys: [],
      snapshotIds: [],
    };
  }

  // Find identity IDs from connections
  const connections = await db
    .selectFrom("connections")
    .select(["id", "identity_id"])
    .where("id", "in", connectionIds)
    .execute();
  const identityIds = Array.from(new Set(connections.map((c) => c.identity_id)));

  // Find repos linked to these connections
  const repoRows = await db
    .selectFrom("repos")
    .select(["id"])
    .where("connection_id", "in", connectionIds)
    .execute();
  const repoIds = repoRows.map((row) => row.id);

  // Find runs associated with these repos
  const runIds = new Set<string>();
  if (repoIds.length > 0) {
    const runRepoRows = await db
      .selectFrom("cloud_run_repos")
      .select(["run_id"])
      .where("repo_id", "in", repoIds)
      .execute();
    for (const row of runRepoRows) runIds.add(row.run_id);

    const primaryRows = await db
      .selectFrom("cloud_runs")
      .select(["id"])
      .where("primary_repo_id", "in", repoIds)
      .execute();
    for (const row of primaryRows) runIds.add(row.id);
  }
  const runIdList = Array.from(runIds);

  // Find sessions from runs
  const runs =
    runIdList.length > 0
      ? await db.selectFrom("cloud_runs").select(["id", "session_id", "status"]).where("id", "in", runIdList).execute()
      : [];
  const sessionIds = runs
    .map((row) => row.session_id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  // Find screenshots
  const screenshotRows =
    runIdList.length > 0
      ? await db.selectFrom("cloud_run_screenshots").select(["s3_key"]).where("run_id", "in", runIdList).execute()
      : [];
  const screenshotKeys = screenshotRows.map((row) => row.s3_key).filter(Boolean);

  // Find snapshots
  const snapshotRows =
    runIdList.length > 0
      ? await db.selectFrom("cloud_snapshots").select(["id"]).where("run_id", "in", runIdList).execute()
      : [];
  const snapshotIds = snapshotRows.map((row) => row.id);

  // Find jsonl paths
  const jsonlRows =
    sessionIds.length > 0
      ? await db.selectFrom("session_stream_offsets").select(["jsonl_path"]).where("session_id", "in", sessionIds).execute()
      : [];
  const jsonlPaths = jsonlRows.map((row) => row.jsonl_path).filter(Boolean);

  return {
    connectionIds,
    identityIds,
    repoIds,
    runIds: runIdList,
    sessionIds,
    jsonlPaths,
    screenshotKeys,
    snapshotIds,
  };
}

// ============================================================================
// Impact Computation
// ============================================================================

/**
 * Compute impact counts directly from a loaded scope — no extra DB queries.
 */
export function computeImpactFromScope(scope: DisconnectScope): DisconnectImpact {
  return {
    repos: scope.repoIds.length,
    runs: scope.runIds.length,
    sessions: scope.sessionIds.length,
    screenshots: scope.screenshotKeys.length,
    snapshots: scope.snapshotIds.length,
  };
}

// ============================================================================
// Sandbox Termination
// ============================================================================

/**
 * Stop running sandboxes for runs in the scope.
 */
export async function stopRunningSandboxes(
  db: Db,
  scope: DisconnectScope,
  cloudManager: CloudManager | null,
  logger: Logger,
): Promise<void> {
  if (!cloudManager || scope.runIds.length === 0) return;

  const runs = await db
    .selectFrom("cloud_runs")
    .select(["id", "session_id", "status"])
    .where("id", "in", scope.runIds)
    .execute();

  for (const run of runs) {
    if (run.session_id && (run.status === "queued" || run.status === "running")) {
      try {
        await cloudManager.stopSandboxForSession(run.session_id);
      } catch (e) {
        logger.warn(`[disconnect_cleanup] stop run failed run=${run.id}: ${String(e)}`);
      }
    }
  }
}

// ============================================================================
// Transactional Cleanup
// ============================================================================

/**
 * Delete repos, runs, sessions, connections, and oauth_states within a transaction.
 * Caller can add provider-specific deletes before/after calling this.
 */
export async function executeCleanupTransaction(
  trx: Transaction<DatabaseSchema>,
  scope: DisconnectScope,
  opts: {
    identityId: string;
    auditKind: string;
    auditPayload: Record<string, unknown>;
    oauthProvider: string;
  },
): Promise<void> {
  const now = nowMs();

  // Clean up repos and related data
  if (scope.repoIds.length > 0) {
    await trx
      .updateTable("identities")
      .set({ active_repo_id: null, updated_at: now })
      .where("active_repo_id", "in", scope.repoIds)
      .execute();
    await trx.deleteFrom("shared_repos").where("repo_id", "in", scope.repoIds).execute();
    await trx.deleteFrom("setup_specs").where("repo_id", "in", scope.repoIds).execute();
    await trx.deleteFrom("cloud_run_repos").where("repo_id", "in", scope.repoIds).execute();
    await trx.updateTable("cloud_runs").set({ primary_repo_id: null }).where("primary_repo_id", "in", scope.repoIds).execute();
    await trx.deleteFrom("repos").where("id", "in", scope.repoIds).execute();
  }

  // Clean up runs
  if (scope.runIds.length > 0) {
    await trx.deleteFrom("cloud_run_screenshots").where("run_id", "in", scope.runIds).execute();
    await trx.deleteFrom("cloud_snapshots").where("run_id", "in", scope.runIds).execute();
    await trx.deleteFrom("cloud_workspaces").where("run_id", "in", scope.runIds).execute();
    await trx.deleteFrom("cloud_runs").where("id", "in", scope.runIds).execute();
  }

  // Clean up sessions
  if (scope.sessionIds.length > 0) {
    await trx.deleteFrom("session_stream_offsets").where("session_id", "in", scope.sessionIds).execute();
    await trx.deleteFrom("sessions").where("id", "in", scope.sessionIds).execute();
  }

  // Delete connections
  if (scope.connectionIds.length > 0) {
    await trx.deleteFrom("connections").where("id", "in", scope.connectionIds).execute();
  }

  // Delete oauth states
  if (scope.identityIds.length > 0) {
    await trx
      .deleteFrom("oauth_states")
      .where("provider", "=", opts.oauthProvider)
      .where("identity_id", "in", scope.identityIds)
      .execute();
  }

  // Record audit event
  await trx.insertInto("audit_events").values({
    id: crypto.randomUUID(),
    session_id: null,
    kind: opts.auditKind,
    payload_json: JSON.stringify(opts.auditPayload),
    identity_id: opts.identityId,
    action: opts.auditKind,
    metadata_json: null,
    created_at: now,
  }).execute();
}

// ============================================================================
// External File Cleanup
// ============================================================================

/**
 * Delete S3 screenshots and local jsonl files outside the transaction.
 */
export async function cleanupExternalFiles(
  scope: DisconnectScope,
  ui: CloudUiSection | null | undefined,
  logger: Logger,
): Promise<void> {
  // Delete S3 screenshots
  if (ui && ui.s3_bucket && ui.s3_region && ui.token_secret) {
    for (const key of scope.screenshotKeys) {
      try {
        await deleteS3Object(ui, key);
      } catch (e) {
        logger.warn(`[disconnect_cleanup] s3 delete failed key=${key}: ${String(e)}`);
      }
    }
  }

  // Delete jsonl files
  for (const path of scope.jsonlPaths) {
    try {
      await unlink(path);
    } catch {
      // ignore missing files
    }
  }
}

/**
 * GitHub OAuth disconnect logic for WebSocket connections.
 *
 * Delegates shared cleanup to disconnectCleanup.ts and handles
 * OAuth-specific concerns (github_mcp_tokens deletion).
 */

import type { CloudSection } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import type { CloudManager } from "./manager.js";
import type { GitHubDisconnectImpact } from "./types.js";
import {
  loadDisconnectScope,
  computeImpactFromScope,
  stopRunningSandboxes,
  executeCleanupTransaction,
  cleanupExternalFiles,
} from "./disconnectCleanup.js";

/**
 * Find the github_oauth connection for an identity
 */
export async function findGithubOAuthConnection(db: Db, identityId: string) {
  return await db
    .selectFrom("connections")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("type", "=", "github_oauth")
    .executeTakeFirst();
}

/**
 * Find all GitHub connections (github_app and github_oauth) for an identity.
 */
export async function findAllGithubConnections(db: Db, identityId: string) {
  return await db
    .selectFrom("connections")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("type", "in", ["github_app", "github_oauth"])
    .execute();
}

/**
 * Compute the impact of disconnecting GitHub connections.
 */
export async function computeGithubDisconnectImpact(db: Db, connectionIds: string[]): Promise<GitHubDisconnectImpact> {
  const scope = await loadDisconnectScope(db, connectionIds);
  return computeImpactFromScope(scope);
}

/**
 * Execute GitHub disconnect — cleans up all related data for all GitHub connections.
 */
export async function executeGithubDisconnect(opts: {
  db: Db;
  cloud: CloudSection;
  logger: Logger;
  connectionIds: string[];
  identityId: string;
  cloudManager: CloudManager | null;
}): Promise<GitHubDisconnectImpact> {
  const scope = await loadDisconnectScope(opts.db, opts.connectionIds);
  const impact = computeImpactFromScope(scope);

  await stopRunningSandboxes(opts.db, scope, opts.cloudManager, opts.logger);

  await opts.db.transaction().execute(async (trx) => {
    // Always clean github_mcp_tokens
    await trx.deleteFrom("github_mcp_tokens").where("identity_id", "=", opts.identityId).execute();

    await executeCleanupTransaction(trx, scope, {
      identityId: opts.identityId,
      auditKind: "github_disconnect",
      auditPayload: {
        connection_ids: opts.connectionIds,
        repo_count: scope.repoIds.length,
        run_count: scope.runIds.length,
      },
      oauthProvider: "github",
    });
  });

  await cleanupExternalFiles(scope, opts.cloud.ui, opts.logger);

  opts.logger.info(
    `[github_disconnect] completed identity=${opts.identityId} connections=${opts.connectionIds.length} repos=${impact.repos} runs=${impact.runs}`,
  );

  return impact;
}

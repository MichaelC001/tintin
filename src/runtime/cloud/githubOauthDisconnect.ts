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
import type { GitHubDisconnectImpact } from "../websocket/types.js";
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
 * Compute the impact of disconnecting a GitHub OAuth connection.
 */
export async function computeOAuthDisconnectImpact(db: Db, connectionId: string): Promise<GitHubDisconnectImpact> {
  const scope = await loadDisconnectScope(db, [connectionId]);
  return computeImpactFromScope(scope);
}

/**
 * Execute GitHub OAuth disconnect - cleans up all related data.
 */
export async function executeOAuthDisconnect(opts: {
  db: Db;
  cloud: CloudSection;
  logger: Logger;
  connectionId: string;
  identityId: string;
  cloudManager: CloudManager | null;
}): Promise<GitHubDisconnectImpact> {
  const scope = await loadDisconnectScope(opts.db, [opts.connectionId]);
  const impact = computeImpactFromScope(scope);

  await stopRunningSandboxes(opts.db, scope, opts.cloudManager, opts.logger);

  await opts.db.transaction().execute(async (trx) => {
    // OAuth-specific: delete github_mcp_tokens
    await trx.deleteFrom("github_mcp_tokens").where("identity_id", "=", opts.identityId).execute();

    await executeCleanupTransaction(trx, scope, {
      identityId: opts.identityId,
      auditKind: "github_oauth_disconnect",
      auditPayload: {
        connection_id: opts.connectionId,
        repo_count: scope.repoIds.length,
        run_count: scope.runIds.length,
      },
      oauthProvider: "github",
    });
  });

  await cleanupExternalFiles(scope, opts.cloud.ui, opts.logger);

  opts.logger.info(
    `[github_oauth_disconnect] completed identity=${opts.identityId} repos=${impact.repos} runs=${impact.runs}`,
  );

  return impact;
}

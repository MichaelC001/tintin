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
 * Find any GitHub connection (github_app or github_oauth) for an identity.
 * Prefers github_oauth if both exist (OAuth has user tokens to delete).
 */
export async function findAnyGithubConnection(db: Db, identityId: string) {
  const connections = await db
    .selectFrom("connections")
    .selectAll()
    .where("identity_id", "=", identityId)
    .where("type", "in", ["github_app", "github_oauth"])
    .execute();

  // Prefer github_oauth if both exist
  return connections.find(c => c.type === 'github_oauth') ?? connections[0] ?? null;
}

/**
 * Compute the impact of disconnecting a GitHub OAuth connection.
 */
export async function computeOAuthDisconnectImpact(db: Db, connectionId: string): Promise<GitHubDisconnectImpact> {
  const scope = await loadDisconnectScope(db, [connectionId]);
  return computeImpactFromScope(scope);
}

/**
 * Execute GitHub OAuth/App disconnect - cleans up all related data.
 * Supports both github_oauth and github_app connection types.
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

  // Fetch connection to determine type
  const connection = await opts.db
    .selectFrom("connections")
    .selectAll()
    .where("id", "=", opts.connectionId)
    .executeTakeFirst();

  const connectionType = connection?.type ?? "github_oauth";
  const isOAuth = connectionType === "github_oauth";

  await opts.db.transaction().execute(async (trx) => {
    // OAuth-specific: delete github_mcp_tokens (only for OAuth connections)
    if (isOAuth) {
      await trx.deleteFrom("github_mcp_tokens").where("identity_id", "=", opts.identityId).execute();
    }

    await executeCleanupTransaction(trx, scope, {
      identityId: opts.identityId,
      auditKind: isOAuth ? "github_oauth_disconnect" : "github_app_disconnect",
      auditPayload: {
        connection_id: opts.connectionId,
        connection_type: connectionType,
        repo_count: scope.repoIds.length,
        run_count: scope.runIds.length,
      },
      oauthProvider: "github",
    });
  });

  await cleanupExternalFiles(scope, opts.cloud.ui, opts.logger);

  opts.logger.info(
    `[${isOAuth ? "github_oauth" : "github_app"}_disconnect] completed identity=${opts.identityId} repos=${impact.repos} runs=${impact.runs}`,
  );

  return impact;
}

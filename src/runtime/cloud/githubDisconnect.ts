/**
 * GitHub App disconnect logic for TG/Slack connections.
 *
 * Delegates shared cleanup to disconnectCleanup.ts and handles
 * GitHub App-specific concerns (installation tokens, webhook events, etc.).
 */

import type { CloudSection } from "../config.js";
import type { Db } from "../db.js";
import type { Logger } from "../log.js";
import { nowMs } from "../util.js";
import type { CloudManager } from "./manager.js";
import { isGithubInstallationMissing } from "./githubApp.js";
import { getGithubInstallation, upsertGithubInstallation } from "./store.js";
import {
  loadDisconnectScope,
  computeImpactFromScope,
  stopRunningSandboxes,
  executeCleanupTransaction,
  cleanupExternalFiles,
} from "./disconnectCleanup.js";

export type GithubDisconnectImpact = {
  installationId: string;
  connections: number;
  identities: number;
  repos: number;
  sharedRepos: number;
  setupSpecs: number;
  runLinks: number;
  runs: number;
  sessions: number;
  screenshots: number;
  snapshots: number;
};

/**
 * Resolve installationId → connectionIds for GitHub App.
 */
async function findConnectionIds(db: Db, installationId: string) {
  const connections = await db
    .selectFrom("connections")
    .select(["id", "identity_id"])
    .where("type", "=", "github_app")
    .where("installation_id", "=", installationId)
    .execute();
  return connections.map((row) => row.id);
}

export async function computeGithubDisconnectImpact(db: Db, installationId: string): Promise<GithubDisconnectImpact> {
  const connectionIds = await findConnectionIds(db, installationId);
  const scope = await loadDisconnectScope(db, connectionIds);
  const base = computeImpactFromScope(scope);

  // TG-specific extra counts
  const sharedRepos =
    scope.repoIds.length > 0
      ? await db
          .selectFrom("shared_repos")
          .select(({ fn }) => fn.count("id").as("count"))
          .where("repo_id", "in", scope.repoIds)
          .executeTakeFirst()
      : null;
  // Count setup specs via projects linked to these repos
  const linkedProjectIds =
    scope.repoIds.length > 0
      ? (await db.selectFrom("projects").select("id").where("repo_id", "in", scope.repoIds).execute()).map((p) => p.id)
      : [];
  const setupSpecs =
    linkedProjectIds.length > 0
      ? await db
          .selectFrom("setup_specs")
          .select(({ fn }) => fn.count("id").as("count"))
          .where("project_id", "in", linkedProjectIds)
          .executeTakeFirst()
      : null;
  const runLinks =
    scope.repoIds.length > 0
      ? await db
          .selectFrom("cloud_run_repos")
          .select(({ fn }) => fn.count("id").as("count"))
          .where("repo_id", "in", scope.repoIds)
          .executeTakeFirst()
      : null;

  return {
    installationId,
    connections: scope.connectionIds.length,
    identities: scope.identityIds.length,
    ...base,
    sharedRepos: Number(sharedRepos?.count ?? 0),
    setupSpecs: Number(setupSpecs?.count ?? 0),
    runLinks: Number(runLinks?.count ?? 0),
  };
}

export async function executeGithubDisconnect(opts: {
  db: Db;
  cloud: CloudSection;
  logger: Logger;
  installationId: string;
  identityId: string;
  cloudManager: CloudManager | null;
}): Promise<GithubDisconnectImpact> {
  const cfg = opts.cloud.github_app;
  if (!cfg) throw new Error("Missing [cloud].github_app configuration.");
  const missing = await isGithubInstallationMissing({ config: cfg, installationId: opts.installationId });
  if (!missing) throw new Error("GitHub App installation still active; uninstall it first.");

  const installation = await getGithubInstallation(opts.db, opts.installationId);
  if (!installation) {
    await upsertGithubInstallation(opts.db, {
      installationId: opts.installationId,
      appId: cfg.app_id,
      status: "disconnecting",
    });
  } else if (installation.status === "disconnecting") {
    throw new Error("Installation disconnect already in progress.");
  }

  await opts.db
    .updateTable("github_installations")
    .set({ status: "disconnecting", updated_at: nowMs() })
    .where("installation_id", "=", opts.installationId)
    .execute();

  const connectionIds = await findConnectionIds(opts.db, opts.installationId);
  const scope = await loadDisconnectScope(opts.db, connectionIds);
  const impact = await computeGithubDisconnectImpact(opts.db, opts.installationId);

  await stopRunningSandboxes(opts.db, scope, opts.cloudManager, opts.logger);

  const now = nowMs();
  await opts.db.transaction().execute(async (trx) => {
    // GitHub App-specific: installation cleanup
    await trx.deleteFrom("github_installation_tokens").where("installation_id", "=", opts.installationId).execute();
    await trx.deleteFrom("github_installation_identities").where("installation_id", "=", opts.installationId).execute();
    await trx
      .updateTable("github_installations")
      .set({
        status: "disconnected",
        account_login: null,
        account_type: null,
        permissions_json: null,
        updated_at: now,
      })
      .where("installation_id", "=", opts.installationId)
      .execute();
    await trx
      .updateTable("github_installation_repos")
      .set({ removed_at: now, updated_at: now })
      .where("installation_id", "=", opts.installationId)
      .execute();
    await trx.deleteFrom("github_webhook_events").where("installation_id", "=", opts.installationId).execute();

    // Shared cleanup
    await executeCleanupTransaction(trx, scope, {
      identityId: opts.identityId,
      auditKind: "github_disconnect",
      auditPayload: {
        installation_id: opts.installationId,
        connection_count: scope.connectionIds.length,
        repo_count: scope.repoIds.length,
        run_count: scope.runIds.length,
      },
      oauthProvider: "github_app",
    });
  });

  await cleanupExternalFiles(scope, opts.cloud.ui, opts.logger);

  return impact;
}

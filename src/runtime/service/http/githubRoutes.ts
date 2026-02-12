import crypto from "node:crypto";
import type http from "node:http";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db.js";
import type { Logger } from "../../log.js";
import type { CloudManager } from "../../cloud/manager.js";
import { readHeader, readRequestBody, sendJson } from "../httpUtils.js";
import { verifyProxyToken } from "../../cloud/proxy.js";
import {
  resolveWebIdentityId,
  listConnections,
  listGithubInstallationsForIdentity,
  listReposForIdentity,
  createPendingAction,
  consumePendingAction,
} from "../../cloud/store.js";
import { parseGithubAppMetadata, startGithubAppFlow } from "../../cloud/githubApp.js";
import { startOAuthFlow } from "../../cloud/oauth.js";
import { syncReposForIdentity } from "../../cloud/repos.js";
import {
  findAllGithubConnections,
  computeGithubDisconnectImpact,
  executeGithubDisconnect,
} from "../../cloud/githubOauthDisconnect.js";

const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACTION_NAME = "github_oauth_disconnect";

interface GithubRouteDeps {
  config: AppConfig;
  db: Db;
  logger: Logger;
  cloudManager: CloudManager | null;
}

export async function handleGithubApiRoutes(params: {
  deps: GithubRouteDeps;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  pathname: string;
  pathParts: string[];
}): Promise<boolean> {
  const { deps, req, res, url, pathParts } = params;

  if (pathParts[0] !== "api" || pathParts[1] !== "github") return false;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.statusCode = 204;
    res.end();
    return true;
  }

  // Auth
  const identityId = requireGithubAuth(deps.config, req, res);
  if (!identityId) return true;

  const subpath = pathParts[2];

  try {
    switch (subpath) {
      case "auth-status":
        if (req.method === "GET") return await handleGetAuthStatus(deps, res, identityId);
        break;
      case "repos":
        if (req.method === "GET") return await handleListRepos(deps, res, url, identityId);
        break;
      case "oauth":
        if (pathParts[3] === "start" && req.method === "POST")
          return await handleStartOAuth(deps, req, res, identityId);
        break;
      case "disconnect":
        if (req.method === "POST") return await handleDisconnect(deps, req, res, identityId);
        break;
      case "connections":
        if (req.method === "GET") return await handleGetConnections(deps, res, identityId);
        break;
    }
  } catch (err) {
    deps.logger.error(`[github-api] ${subpath} error: ${String(err)}`);
    sendJson(res, 500, { error: "Internal server error" });
    return true;
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}

function requireGithubAuth(
  config: AppConfig,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): string | null {
  const secret = config.cloud?.proxy?.shared_secret;
  if (!secret) {
    sendJson(res, 503, { error: "Auth not configured" });
    return null;
  }

  const authHeader = readHeader(req, "authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    sendJson(res, 401, { error: "Missing authorization token" });
    return null;
  }

  const verified = verifyProxyToken(secret, token);
  if (!verified) {
    sendJson(res, 401, { error: "Invalid or expired token" });
    return null;
  }

  return verified.identityId;
}

// GET /api/github/auth-status
async function handleGetAuthStatus(
  deps: GithubRouteDeps,
  res: http.ServerResponse,
  identityId: string,
): Promise<boolean> {
  const dbIdentityId = await resolveWebIdentityId(deps.db, identityId);
  const connections = await listConnections(deps.db, dbIdentityId);

  let connected = false;
  let accountLogin: string | undefined;
  let installationId: string | undefined;

  const githubAppConn = connections.find(c => c.type === "github_app");
  const githubOAuthConn = connections.find(c => c.type === "github_oauth");

  if (githubAppConn) {
    installationId = githubAppConn.installation_id ?? undefined;
    const metadata = parseGithubAppMetadata(githubAppConn.metadata_json);
    accountLogin = metadata?.account_login;

    const installations = await listGithubInstallationsForIdentity(deps.db, dbIdentityId);
    const inst = installationId
      ? installations.find(i => i.installation_id === installationId)
      : undefined;

    if (inst && inst.status !== "active") {
      connected = false;
    } else {
      connected = true;
    }

    if (!accountLogin) {
      accountLogin = inst?.account_login ?? undefined;
    }
  } else if (githubOAuthConn) {
    connected = true;
  }

  sendJson(res, 200, { connected, accountLogin, installationId });
  return true;
}

// GET /api/github/repos?search=keyword
async function handleListRepos(
  deps: GithubRouteDeps,
  res: http.ServerResponse,
  url: URL,
  identityId: string,
): Promise<boolean> {
  const dbIdentityId = await resolveWebIdentityId(deps.db, identityId);

  const { stale } = await syncReposForIdentity({
    db: deps.db,
    config: deps.config.cloud,
    identityId: dbIdentityId,
  });

  let repos = await listReposForIdentity(deps.db, dbIdentityId);

  const provider = url.searchParams.get("provider");
  if (provider) {
    repos = repos.filter(r => r.provider === provider);
  }

  const search = url.searchParams.get("search");
  if (search) {
    const searchLower = search.toLowerCase();
    repos = repos.filter(r => r.name.toLowerCase().includes(searchLower));
  }

  sendJson(res, 200, {
    repos: repos.map(r => ({
      id: r.id,
      name: r.name,
      url: r.url,
      provider: r.provider,
      defaultBranch: r.default_branch,
    })),
    total: repos.length,
    stale,
  });
  return true;
}

// POST /api/github/oauth/start
async function handleStartOAuth(
  deps: GithubRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identityId: string,
): Promise<boolean> {
  const cloud = deps.config.cloud;
  if (!cloud) {
    sendJson(res, 503, { error: "Cloud configuration not available" });
    return true;
  }

  const dbIdentityId = await resolveWebIdentityId(deps.db, identityId);

  let body: { provider?: string; returnUrl?: string } = {};
  try {
    const raw = await readRequestBody(req);
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return true;
  }

  const provider = body.provider ?? "github";

  // Build redirect base from config
  const host = deps.config.bot.host ?? "localhost";
  const port = deps.config.bot.port ?? 3000;
  const protocol = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
  const redirectBase = `${protocol}://${host}${port === 80 || port === 443 ? "" : `:${port}`}`;

  const returnUrl = body.returnUrl && isAllowedReturnUrl(body.returnUrl) ? body.returnUrl : null;
  const metadataJson = JSON.stringify({ source: "http", ...(returnUrl && { returnUrl }) });

  let authorizeUrl: string;

  if (provider === "github") {
    if (cloud.github_app?.app_id && cloud.github_app?.app_slug && cloud.github_app?.private_key) {
      const result = await startGithubAppFlow({
        db: deps.db,
        cloud,
        identityId: dbIdentityId,
        redirectBase,
        metadataJson,
      });
      authorizeUrl = result.authorizeUrl;
    } else if (cloud.oauth?.github) {
      const result = await startOAuthFlow({
        db: deps.db,
        cloud,
        provider: "github",
        identityId: dbIdentityId,
        redirectBase,
        metadataJson,
      });
      authorizeUrl = result.authorizeUrl;
    } else {
      sendJson(res, 503, { error: "GitHub authentication not configured" });
      return true;
    }
  } else if (provider === "gitlab") {
    if (!cloud.oauth?.gitlab) {
      sendJson(res, 503, { error: "GitLab OAuth not configured" });
      return true;
    }
    const result = await startOAuthFlow({
      db: deps.db,
      cloud,
      provider: "gitlab",
      identityId: dbIdentityId,
      redirectBase,
      metadataJson,
    });
    authorizeUrl = result.authorizeUrl;
  } else {
    sendJson(res, 400, { error: `Unsupported provider: ${provider}` });
    return true;
  }

  sendJson(res, 200, { authorizeUrl });
  return true;
}

// POST /api/github/disconnect
async function handleDisconnect(
  deps: GithubRouteDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identityId: string,
): Promise<boolean> {
  const cloud = deps.config.cloud;
  if (!cloud?.enabled) {
    sendJson(res, 200, { action: "error", error: "Cloud features not enabled" });
    return true;
  }

  const dbIdentityId = await resolveWebIdentityId(deps.db, identityId);

  let body: { action?: string; token?: string } = {};
  try {
    const raw = await readRequestBody(req);
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return true;
  }

  if (body.action === "preview") {
    const connections = await findAllGithubConnections(deps.db, dbIdentityId);
    if (connections.length === 0) {
      sendJson(res, 200, { action: "error", error: "No GitHub connection found" });
      return true;
    }

    const connectionIds = connections.map(c => c.id);
    const impact = await computeGithubDisconnectImpact(deps.db, connectionIds);

    const token = crypto.randomBytes(24).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    await createPendingAction(deps.db, {
      action: ACTION_NAME,
      identityId: dbIdentityId,
      tokenHash,
      payloadJson: JSON.stringify({ connectionIds }),
      ttlMs: CONFIRM_TOKEN_TTL_MS,
    });

    deps.logger.info(
      `[github-api] disconnect preview connections=${connectionIds.length} repos=${impact.repos} runs=${impact.runs}`,
    );

    sendJson(res, 200, {
      action: "preview",
      impact,
      confirmToken: token,
      expiresIn: CONFIRM_TOKEN_TTL_MS,
    });
    return true;
  }

  if (body.action === "confirm") {
    if (!body.token) {
      sendJson(res, 200, { action: "error", error: "Missing confirmation token" });
      return true;
    }

    const tokenHash = crypto.createHash("sha256").update(body.token).digest("hex");
    const pending = await consumePendingAction(deps.db, {
      action: ACTION_NAME,
      identityId: dbIdentityId,
      tokenHash,
    });

    if (!pending) {
      sendJson(res, 200, { action: "error", error: "Invalid or expired confirmation token" });
      return true;
    }

    let payload: { connectionIds: string[] };
    try {
      payload = JSON.parse(pending.payload_json);
    } catch {
      sendJson(res, 200, { action: "error", error: "Invalid token payload" });
      return true;
    }

    const impact = await executeGithubDisconnect({
      db: deps.db,
      cloud,
      logger: deps.logger,
      connectionIds: payload.connectionIds,
      identityId: dbIdentityId,
      cloudManager: deps.cloudManager,
    });

    deps.logger.info(
      `[github-api] disconnect completed repos=${impact.repos} runs=${impact.runs}`,
    );

    sendJson(res, 200, { action: "result", success: true, impact });
    return true;
  }

  sendJson(res, 200, { action: "error", error: "Invalid action" });
  return true;
}

// GET /api/github/connections
async function handleGetConnections(
  deps: GithubRouteDeps,
  res: http.ServerResponse,
  identityId: string,
): Promise<boolean> {
  const dbIdentityId = await resolveWebIdentityId(deps.db, identityId);
  const connections = await listConnections(deps.db, dbIdentityId);

  const result: Array<{
    id: string;
    type: string;
    installationId?: string;
    accountLogin?: string;
    status?: string;
    createdAt: number;
  }> = [];

  for (const c of connections) {
    const item: (typeof result)[number] = {
      id: c.id,
      type: c.type,
      createdAt: c.created_at,
    };

    if (c.type === "github_app" && c.installation_id) {
      item.installationId = c.installation_id;
      const metadata = parseGithubAppMetadata(c.metadata_json);
      if (metadata?.account_login) {
        item.accountLogin = metadata.account_login;
      }
      item.status = "active";
    }

    result.push(item);
  }

  // Also include GitHub installations that might not have a connection yet
  const installations = await listGithubInstallationsForIdentity(deps.db, dbIdentityId);
  for (const inst of installations) {
    const existingConn = result.find(c => c.type === "github_app" && c.installationId === inst.installation_id);
    if (!existingConn) {
      result.push({
        id: inst.installation_id,
        type: "github_app",
        installationId: inst.installation_id,
        accountLogin: inst.account_login ?? undefined,
        status: inst.status ?? "active",
        createdAt: inst.created_at,
      });
    } else if (!existingConn.accountLogin && inst.account_login) {
      existingConn.accountLogin = inst.account_login;
      existingConn.status = inst.status ?? "active";
    }
  }

  sendJson(res, 200, { connections: result });
  return true;
}

// ============================================================================
// returnUrl validation (open redirect prevention)
// ============================================================================

const ALLOWED_RETURN_ORIGINS = (process.env.ALLOWED_REDIRECT_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedReturnUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return true;
    if (ALLOWED_RETURN_ORIGINS.length === 0) return false;
    return ALLOWED_RETURN_ORIGINS.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function extractReturnUrl(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson);
    const url = parsed?.returnUrl;
    return typeof url === "string" && isAllowedReturnUrl(url) ? url : null;
  } catch {
    return null;
  }
}

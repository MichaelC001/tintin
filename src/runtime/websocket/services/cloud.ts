import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { CloudManager } from '../../cloud/manager.js';
import type { WebSocketManager } from '../manager.js';
import type { CloudRunMessage, WSConnection } from '../types.js';
import { ErrorCodes } from '../types.js';
import { IdentityResolver } from './identity.js';
import { CloudLinkBuilder } from './linkBuilder.js';
import { listReposForIdentity, getCloudRun } from '../../cloud/store.js';
import { mapDbStatusToWsStatus } from '../../cloud/types.js';

/**
 * CloudRunService - Handles WebSocket cloud run requests.
 * Follows SRP: Only responsible for cloud run creation and subscription.
 * Follows DIP: All dependencies injected via constructor.
 */
export class CloudRunService {
  private readonly identityResolver: IdentityResolver;
  private readonly linkBuilder: CloudLinkBuilder;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly cloudManager: CloudManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
  ) {
    this.identityResolver = new IdentityResolver(db);
    this.linkBuilder = new CloudLinkBuilder(config);
  }

  async handleCloudRun(
    connId: string,
    conn: WSConnection,
    message: CloudRunMessage,
  ): Promise<void> {
    const prompt = message.prompt?.trim();
    if (!prompt) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Prompt is required',
      });
      return;
    }

    try {
      const dbIdentityId = await this.identityResolver.resolve(conn.identityId!);
      const repoIds = message.repoIds ?? [];
      const isPlayground = repoIds.length === 0;

      // Validate repo access if repos specified
      if (!isPlayground) {
        const accessible = await this.validateRepoAccess(dbIdentityId, repoIds);
        if (!accessible) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.ACCESS_DENIED,
            message: 'You do not have access to one or more specified repositories',
          });
          return;
        }
      }

      // Determine agent
      const agent = message.agent ?? (this.config.cloud?.default_agent === 'claude_code' ? 'claude_code' : 'codex');

      // Send initial status
      this.wsManager.sendToConnection(connId, {
        type: 'run_status',
        runId: '', // Will be updated after run creation
        status: 'preparing',
        message: isPlayground ? 'Starting playground session' : 'Preparing cloud sandbox',
      });

      // Build virtual chat/space IDs for WebSocket
      const virtualChatId = `ws:${conn.identityId}`;
      const virtualSpaceId = `${Date.now()}`;

      // Start cloud run
      const { runId, sessionId, cdpUrl } = await this.cloudManager.startRun({
        identityId: dbIdentityId,
        platform: 'websocket',
        workspaceId: null,
        chatId: virtualChatId,
        spaceId: virtualSpaceId,
        userId: conn.identityId!,
        prompt,
        repoIds,
        agent,
        playground: isPlayground,
        restoreSnapshotId: message.restoreSnapshotId ?? null,
      });

      // Subscribe connection to session
      this.wsManager.subscribeToSession(connId, sessionId);

      // Send session started message
      this.wsManager.sendToConnection(connId, {
        type: 'session_started',
        sessionId,
        runId,
      });

      // Send browser session CDP URL if available
      if (cdpUrl) {
        this.wsManager.sendToConnection(connId, {
          type: 'browser_session',
          sessionId,
          runId,
          cdpUrl,
          provider: 'hyperbrowser',
        });
      }

      // Send run links (viewUrl and codeProxyUrl immediately available)
      const viewUrl = this.linkBuilder.buildViewUrl(runId);
      const codeProxyUrl = this.linkBuilder.buildCodeProxyUrl(sessionId);
      this.wsManager.sendToConnection(connId, {
        type: 'run_links',
        runId,
        sessionId,
        viewUrl,
        codeProxyUrl,
      });

      // Start background polling for VS Code URL (code-server takes time to start)
      this.pollAndSendVscodeUrl(connId, runId, sessionId).catch((err) => {
        this.logger.debug(`[ws][cloud] vscode poll error runId=${runId}: ${String(err)}`);
      });

      this.logger.info(
        `[ws][cloud] run started connId=${connId} runId=${runId} sessionId=${sessionId} repos=${repoIds.length} agent=${agent}`,
      );
    } catch (err) {
      this.logger.error(`[ws][cloud] handleCloudRun error connId=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to start cloud run: ${String(err)}`,
      });
    }
  }

  async handleSubscribeRun(connId: string, runId: string): Promise<void> {
    try {
      const run = await getCloudRun(this.db, runId);
      if (!run) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SESSION_NOT_FOUND,
          message: 'Run not found',
        });
        return;
      }

      const sessionId = run.session_id;
      if (!sessionId) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SESSION_NOT_FOUND,
          message: 'Run has no associated session',
        });
        return;
      }

      // Subscribe to the session
      this.wsManager.subscribeToSession(connId, sessionId);

      // Send current run status
      this.wsManager.sendToConnection(connId, {
        type: 'run_status',
        runId,
        status: mapDbStatusToWsStatus(run.status),
      });

      // Send run links
      const viewUrl = this.linkBuilder.buildViewUrl(runId);
      const codeProxyUrl = this.linkBuilder.buildCodeProxyUrl(sessionId);
      this.wsManager.sendToConnection(connId, {
        type: 'run_links',
        runId,
        sessionId,
        viewUrl,
        codeProxyUrl,
      });

      // Try to get VS Code URL immediately, or start polling if not available
      this.pollAndSendVscodeUrl(connId, runId, sessionId).catch((err) => {
        this.logger.debug(`[ws][cloud] vscode poll error runId=${runId}: ${String(err)}`);
      });

      this.logger.debug(`[ws][cloud] subscribed to run connId=${connId} runId=${runId} sessionId=${sessionId}`);
    } catch (err) {
      this.logger.error(`[ws][cloud] handleSubscribeRun error connId=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to subscribe to run: ${String(err)}`,
      });
    }
  }

  /**
   * Validate that the identity has access to all specified repos.
   */
  private async validateRepoAccess(identityId: string, repoIds: string[]): Promise<boolean> {
    if (repoIds.length === 0) return true;

    const accessibleRepos = await listReposForIdentity(this.db, identityId);
    const accessibleIds = new Set(accessibleRepos.map((r) => r.id));

    for (const repoId of repoIds) {
      if (!accessibleIds.has(repoId)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Poll for VS Code tunnel URL and send run_links message when available.
   * Runs in background - does not block the main flow.
   *
   * @param connId - WebSocket connection ID
   * @param runId - Cloud run ID
   * @param sessionId - Session ID for the cloud run
   * @param maxAttempts - Maximum number of polling attempts (default: 15)
   * @param intervalMs - Polling interval in milliseconds (default: 2000)
   */
  private async pollAndSendVscodeUrl(
    connId: string,
    runId: string,
    sessionId: string,
    maxAttempts = 15,
    intervalMs = 2000,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check if connection is still alive
      if (!this.wsManager.getConnection(connId)) {
        this.logger.debug(`[ws][cloud] vscode poll stopped: connection closed connId=${connId}`);
        return;
      }

      // Try to get VS Code tunnel URL
      const tunnelUrl = await this.cloudManager.getVscodeUrl(sessionId).catch(() => null);
      if (tunnelUrl) {
        const vscodeUrl = this.linkBuilder.buildVscodeUrl(tunnelUrl);
        const codeProxyUrl = this.linkBuilder.buildCodeProxyUrl(sessionId);
        this.wsManager.sendToConnection(connId, {
          type: 'run_links',
          runId,
          sessionId,
          vscodeUrl,
          codeProxyUrl,
        });
        this.logger.debug(`[ws][cloud] vscode url sent connId=${connId} runId=${runId}`);
        return;
      }

      // Wait before next attempt
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    this.logger.debug(
      `[ws][cloud] vscode poll exhausted after ${maxAttempts} attempts connId=${connId} runId=${runId}`,
    );
  }
}

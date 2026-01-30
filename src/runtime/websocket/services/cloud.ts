import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { CloudManager } from '../../cloud/manager.js';
import type { WebSocketManager } from '../manager.js';
import type { CloudRunMessage, CloudFollowUpMessage, WSConnection } from '../types.js';
import { ErrorCodes } from '../types.js';
import { IdentityResolver } from './identity.js';
import { CloudLinkBuilder } from './linkBuilder.js';
import type { SandboxLifecycleService } from './sandboxLifecycle.js';
import { listReposForIdentity, getCloudRun } from '../../cloud/store.js';
import { mapDbStatusToWsStatus } from '../../cloud/types.js';
import type { SessionRow } from '../../store.js';

interface FollowUpEntry {
  connId: string;
  prompt: string;
  runId: string;
}

const MAX_QUEUE_SIZE = 50;

/**
 * CloudRunService - Handles WebSocket cloud run requests.
 * Follows SRP: Only responsible for cloud run creation and subscription.
 * Follows DIP: All dependencies injected via constructor.
 */
export class CloudRunService {
  private readonly identityResolver: IdentityResolver;
  private readonly linkBuilder: CloudLinkBuilder;
  /** In-memory follow-up queues keyed by sessionId */
  private readonly followUpQueues = new Map<string, FollowUpEntry[]>();

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly cloudManager: CloudManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly sandboxService: SandboxLifecycleService | null = null,
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

    // Check sandbox status if sandboxService is available
    if (this.sandboxService) {
      const { status, error } = this.sandboxService.getSandboxStatus(connId);

      if (status === 'provisioning') {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SERVICE_ERROR,
          message: 'Sandbox is still provisioning. Please wait for sandbox_ready message.',
        });
        return;
      }

      if (status === 'in_use') {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SERVICE_ERROR,
          message: 'Sandbox is currently in use. Stop the current run first.',
        });
        return;
      }

      if (status === 'error') {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SERVICE_ERROR,
          message: `Sandbox error: ${error ?? 'Unknown error'}. Please reconnect.`,
        });
        return;
      }

      if (status === 'terminating') {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SERVICE_ERROR,
          message: 'Sandbox is terminating. Please reconnect.',
        });
        return;
      }
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

      // Determine snapshot ID for restore
      // Priority: explicit restoreSnapshotId > autoRestore detection
      let restoreSnapshotId = message.restoreSnapshotId ?? null;

      if (!restoreSnapshotId && message.autoRestore) {
        restoreSnapshotId = await this.cloudManager.detectLatestSnapshot({
          identityId: dbIdentityId,
          lastRunId: message.lastRunId ?? null,
        });
        if (restoreSnapshotId) {
          this.logger.info(
            `[ws][cloud] auto-restore snapshot=${restoreSnapshotId} connId=${connId} lastRunId=${message.lastRunId ?? 'none'}`,
          );
        }
      }

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

      let runId: string;
      let sessionId: string;
      let cdpUrl: string | null;

      // Check if we can use an existing connection sandbox
      const sandbox = this.sandboxService?.getSandbox(connId);

      if (sandbox) {
        // Use existing workspace via startRunWithWorkspace
        this.logger.info(
          `[ws][cloud] using connection sandbox connId=${connId} workspaceId=${sandbox.workspaceId}`,
        );

        const result = await this.cloudManager.startRunWithWorkspace({
          workspace: { id: sandbox.workspaceId, rootPath: sandbox.rootPath },
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
          restoreSnapshotId,
        });

        runId = result.runId;
        sessionId = result.sessionId;
        cdpUrl = result.cdpUrl;

        // Mark sandbox as in use
        this.sandboxService!.markInUse(connId, runId, sessionId);
      } else {
        // Fall back to creating a new workspace (legacy behavior)
        this.logger.info(`[ws][cloud] no connection sandbox, using startRun connId=${connId}`);

        const result = await this.cloudManager.startRun({
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
          restoreSnapshotId,
        });

        runId = result.runId;
        sessionId = result.sessionId;
        cdpUrl = result.cdpUrl;
      }

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

      // Send run links (viewUrl immediately available, codeServerUrl will be sent when available)
      const viewUrl = this.linkBuilder.buildViewUrl(runId);
      this.wsManager.sendToConnection(connId, {
        type: 'run_links',
        runId,
        sessionId,
        viewUrl,
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

      // Mark sandbox as ready again on error (if using sandbox)
      if (this.sandboxService) {
        this.sandboxService.markReady(connId);
      }

      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to start cloud run: ${String(err)}`,
      });
    }
  }

  /**
   * Stop a cloud run by its run ID.
   * Validates ownership, kills the session, and marks sandbox as ready.
   */
  async handleCloudStop(
    connId: string,
    conn: WSConnection,
    runId: string,
  ): Promise<void> {
    try {
      const validated = await this.validateRun(connId, runId);
      if (!validated) return;

      const { run, sessionId } = validated;

      // Validate ownership
      const dbIdentityId = await this.identityResolver.resolve(conn.identityId!);
      if (run.identity_id !== dbIdentityId) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.ACCESS_DENIED,
          message: 'You do not have access to this run',
        });
        return;
      }

      // Stop the cloud run
      const stopped = await this.cloudManager.stopCloudRun(runId);
      if (!stopped) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SERVICE_ERROR,
          message: 'Failed to stop run',
        });
        return;
      }

      // Mark sandbox as ready
      if (this.sandboxService) {
        this.sandboxService.markReady(connId);
      }

      // Broadcast done to all subscribers
      this.wsManager.broadcastToSession(sessionId, {
        type: 'done',
        sessionId,
        stopped: true,
      });

      this.logger.info(`[ws][cloud] run stopped connId=${connId} runId=${runId} sessionId=${sessionId}`);
    } catch (err) {
      this.logger.error(`[ws][cloud] handleCloudStop error connId=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to stop cloud run: ${String(err)}`,
      });
    }
  }

  async handleSubscribeRun(connId: string, runId: string): Promise<void> {
    try {
      const validated = await this.validateRun(connId, runId);
      if (!validated) return;

      const { run, sessionId } = validated;

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
      this.wsManager.sendToConnection(connId, {
        type: 'run_links',
        runId,
        sessionId,
        viewUrl,
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
   * Handle a follow-up prompt on an existing cloud run.
   * If the session is still running, the prompt is queued.
   * If the session is finished/error, it resumes or restarts the sandbox.
   */
  async handleCloudFollowUp(
    connId: string,
    conn: WSConnection,
    message: CloudFollowUpMessage,
  ): Promise<void> {
    const { runId } = message;
    const prompt = message.prompt?.trim();

    if (!runId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Run ID required',
      });
      return;
    }

    if (!prompt) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Prompt is required',
      });
      return;
    }

    try {
      // Validate the run exists and has a session
      const validated = await this.validateRun(connId, runId);
      if (!validated) return;

      const { run, sessionId } = validated;

      // Validate ownership
      const dbIdentityId = await this.identityResolver.resolve(conn.identityId!);
      if (run.identity_id !== dbIdentityId) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.ACCESS_DENIED,
          message: 'You do not have access to this run',
        });
        return;
      }

      // Get session to check status
      const session = await this.db
        .selectFrom('sessions')
        .selectAll()
        .where('id', '=', sessionId)
        .executeTakeFirst();

      if (!session) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.SESSION_NOT_FOUND,
          message: 'Session not found',
        });
        return;
      }

      // Check if session was killed - cannot resume
      if (session.status === 'killed') {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.RUN_NOT_RESUMABLE,
          message: 'Run was killed and cannot be resumed',
        });
        return;
      }

      // If session is still active, queue the follow-up
      if (session.status === 'running' || session.status === 'starting') {
        const position = this.enqueueFollowUp(sessionId, { connId, prompt, runId });
        if (position < 0) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.RATE_LIMIT,
            message: 'Follow-up queue is full',
          });
          return;
        }

        // Subscribe to session so client receives updates
        this.wsManager.subscribeToSession(connId, sessionId);

        this.wsManager.sendToConnection(connId, {
          type: 'follow_up_queued',
          runId,
          sessionId,
          position,
        });

        this.logger.info(
          `[ws][cloud] follow-up queued connId=${connId} runId=${runId} sessionId=${sessionId} position=${position}`,
        );
        return;
      }

      // Session is finished or errored - attempt resume/restart
      await this.resumeFollowUp(connId, runId, sessionId, session as SessionRow, prompt);
    } catch (err) {
      this.logger.error(`[ws][cloud] handleCloudFollowUp error connId=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to process follow-up: ${String(err)}`,
      });
    }
  }

  /**
   * Process queued follow-up prompts after a session completes.
   * Called by the sandbox lifecycle / session completion hook.
   */
  async processQueuedFollowUps(sessionId: string): Promise<void> {
    const queue = this.followUpQueues.get(sessionId);
    if (!queue || queue.length === 0) {
      this.followUpQueues.delete(sessionId);
      return;
    }

    // Take next entry
    const entry = queue.shift()!;
    if (queue.length === 0) {
      this.followUpQueues.delete(sessionId);
    }

    // Check if the connection is still alive
    const conn = this.wsManager.getConnection(entry.connId);
    if (!conn) {
      this.logger.debug(
        `[ws][cloud] follow-up skipped: connection closed connId=${entry.connId} sessionId=${sessionId}`,
      );
      // Try next entry
      await this.processQueuedFollowUps(sessionId);
      return;
    }

    const session = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();

    if (!session) {
      this.logger.warn(`[ws][cloud] follow-up skipped: session not found sessionId=${sessionId}`);
      return;
    }

    try {
      await this.resumeFollowUp(entry.connId, entry.runId, sessionId, session as SessionRow, entry.prompt);
    } catch (err) {
      this.logger.error(
        `[ws][cloud] processQueuedFollowUps error sessionId=${sessionId}: ${String(err)}`,
      );
      this.wsManager.sendToConnection(entry.connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to process queued follow-up: ${String(err)}`,
      });
      // Continue processing queue even on error
      await this.processQueuedFollowUps(sessionId);
    }
  }

  /**
   * Clean up follow-up queue entries for a disconnected connection.
   */
  cleanupConnection(connId: string): void {
    for (const [sessionId, queue] of this.followUpQueues.entries()) {
      const filtered = queue.filter((e) => e.connId !== connId);
      if (filtered.length === 0) {
        this.followUpQueues.delete(sessionId);
      } else {
        this.followUpQueues.set(sessionId, filtered);
      }
    }
  }

  private enqueueFollowUp(sessionId: string, entry: FollowUpEntry): number {
    let queue = this.followUpQueues.get(sessionId);
    if (!queue) {
      queue = [];
      this.followUpQueues.set(sessionId, queue);
    }
    if (queue.length >= MAX_QUEUE_SIZE) {
      return -1;
    }
    queue.push(entry);
    return queue.length;
  }

  private async resumeFollowUp(
    connId: string,
    runId: string,
    sessionId: string,
    session: SessionRow,
    prompt: string,
  ): Promise<void> {
    // Subscribe to session so client receives updates
    this.wsManager.subscribeToSession(connId, sessionId);

    // Try resume (sandbox still alive)
    const resumed = await this.cloudManager.resumeCloudSession(session, prompt);
    if (resumed === 'resumed') {
      this.wsManager.sendToConnection(connId, {
        type: 'follow_up_resuming',
        runId,
        sessionId,
        status: 'resuming',
      });

      // Mark sandbox as in use if we have sandbox service
      if (this.sandboxService) {
        this.sandboxService.markInUse(connId, runId, sessionId);
      }

      this.logger.info(
        `[ws][cloud] follow-up resumed connId=${connId} runId=${runId} sessionId=${sessionId}`,
      );
      return;
    }

    if (resumed === 'expired') {
      // Sandbox expired, need to restart
      this.wsManager.sendToConnection(connId, {
        type: 'follow_up_resuming',
        runId,
        sessionId,
        status: 'restarting',
      });

      const restarted = await this.cloudManager.restartCloudSession(session, prompt);
      if (restarted === 'restarted') {
        this.logger.info(
          `[ws][cloud] follow-up restarted connId=${connId} runId=${runId} sessionId=${sessionId}`,
        );
        return;
      }
    }

    // If resume and restart both failed
    this.wsManager.sendToConnection(connId, {
      type: 'error',
      code: ErrorCodes.SERVICE_ERROR,
      message: 'Failed to resume or restart session',
    });
  }

  /**
   * Validate that a run exists and has an associated session.
   * Sends error messages to the client if validation fails.
   * Returns the run and sessionId on success, or null on failure.
   */
  private async validateRun(connId: string, runId: string) {
    const run = await getCloudRun(this.db, runId);
    if (!run) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: 'Run not found',
      });
      return null;
    }

    const sessionId = run.session_id;
    if (!sessionId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: 'Run has no associated session',
      });
      return null;
    }

    return { run, sessionId };
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
        this.wsManager.sendToConnection(connId, {
          type: 'run_links',
          runId,
          sessionId,
          vscodeUrl,
          codeServerUrl: tunnelUrl,  // Direct Modal tunnel URL
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

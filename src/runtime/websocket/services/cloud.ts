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
import { listReposForIdentity, getCloudRunBySession, getProject, getOrCreatePlaygroundProject, getOrCreateRepoProject } from '../../cloud/store.js';
import { isPlayground as isPlaygroundProject, type Project } from '../../cloud/project.js';
import { mapDbStatusToWsStatus } from '../../cloud/types.js';
import { countConcurrentSessionsForUser, countSessionsForUser, getLatestSessionForChat } from '../../store.js';
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
    const chatId = this.normalizeChatId(message.chatId);
    if (!chatId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Valid chatId is required',
      });
      return;
    }

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
          message: 'Sandbox is still provisioning. Please wait for sandbox_status ready.',
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

      // Resolve project: prefer projectId, fall back to repoIds
      let project: Project;
      let repoIds: string[];
      if (message.projectId) {
        const p = await getProject(this.db, message.projectId);
        if (!p) {
          this.wsManager.sendToConnection(connId, {
            type: 'error',
            code: ErrorCodes.INVALID_MESSAGE,
            message: 'Project not found',
          });
          return;
        }
        project = { id: p.id, identityId: p.identity_id, type: p.type as "repo" | "playground", repoId: p.repo_id, name: p.name };
        repoIds = p.repo_id ? [p.repo_id] : [];
      } else {
        const msgRepoIds = message.repoIds ?? [];
        repoIds = msgRepoIds;
        if (msgRepoIds.length === 0) {
          const pg = await getOrCreatePlaygroundProject(this.db, dbIdentityId);
          project = { id: pg.id, identityId: pg.identity_id, type: pg.type as "repo" | "playground", repoId: pg.repo_id, name: pg.name };
        } else {
          const repo = await this.db.selectFrom("repos").select("name").where("id", "=", msgRepoIds[0]!).executeTakeFirst();
          const rp = await getOrCreateRepoProject(this.db, dbIdentityId, msgRepoIds[0]!, repo?.name ?? "repo");
          project = { id: rp.id, identityId: rp.identity_id, type: rp.type as "repo" | "playground", repoId: rp.repo_id, name: rp.name };
        }
      }
      const isPlayground = isPlaygroundProject(project);
      const virtualChatId = this.buildVirtualChatId(conn.identityId!, chatId);

      const identityOk = await this.assertIdentitySessionLimits(connId, dbIdentityId);
      if (!identityOk) return;
      const activeSession = await getLatestSessionForChat(this.db, 'websocket', virtualChatId, ['starting', 'running']);
      if (activeSession) {
        this.wsManager.sendToConnection(connId, {
          type: 'error',
          code: ErrorCodes.INVALID_MESSAGE,
          message: 'Chat already has an active run. Stop it or send a follow-up.',
        });
        return;
      }

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
      const virtualSpaceId = `${chatId}:${Date.now()}`;

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
          project,
          repoIds,
          agent,
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
          project,
          repoIds,
          agent,
          restoreSnapshotId,
        });

        runId = result.runId;
        sessionId = result.sessionId;
        cdpUrl = result.cdpUrl;
      }

      // Subscribe connection to session
      this.wsManager.subscribeToSession(connId, sessionId);

      // Send session started via run_status
      this.wsManager.sendToConnection(connId, {
        type: 'run_status',
        runId,
        sessionId,
        status: 'started',
      });

      // Send browser session CDP URL if available
      if (cdpUrl) {
        const liveViewUrl = this.cloudManager.getLiveViewUrl(sessionId);
        this.wsManager.sendToConnection(connId, {
          type: 'browser_session',
          sessionId,
          runId,
          cdpUrl,
          liveViewUrl: liveViewUrl ?? undefined,
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
   * Stop a cloud run by chat ID (latest running session).
   * Validates ownership, kills the session, and marks sandbox as ready.
   */
  async handleCloudStop(
    connId: string,
    conn: WSConnection,
    chatId: string,
  ): Promise<void> {
    try {
      const validated = await this.resolveChatRun(connId, conn, chatId, { requireRunning: true });
      if (!validated) return;

      const { run, sessionId } = validated;

      // Stop the cloud run
      const stopped = await this.cloudManager.stopCloudRun(run.id);
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

      this.logger.info(`[ws][cloud] run stopped connId=${connId} runId=${run.id} sessionId=${sessionId}`);
    } catch (err) {
      this.logger.error(`[ws][cloud] handleCloudStop error connId=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SERVICE_ERROR,
        message: `Failed to stop cloud run: ${String(err)}`,
      });
    }
  }

  async handleSubscribeChat(connId: string, conn: WSConnection, chatId: string): Promise<void> {
    try {
      const validated = await this.resolveChatRun(connId, conn, chatId, { preferRunning: true });
      if (!validated) return;

      const { run, sessionId } = validated;

      // Subscribe to the session
      this.wsManager.subscribeToSession(connId, sessionId);

      // Send current run status
      this.wsManager.sendToConnection(connId, {
        type: 'run_status',
        runId: run.id,
        status: mapDbStatusToWsStatus(run.status),
      });

      // Send run links
      const viewUrl = this.linkBuilder.buildViewUrl(run.id);
      this.wsManager.sendToConnection(connId, {
        type: 'run_links',
        runId: run.id,
        sessionId,
        viewUrl,
      });

      // Try to get VS Code URL immediately, or start polling if not available
      this.pollAndSendVscodeUrl(connId, run.id, sessionId).catch((err) => {
        this.logger.debug(`[ws][cloud] vscode poll error runId=${run.id}: ${String(err)}`);
      });

      this.logger.debug(`[ws][cloud] subscribed to run connId=${connId} runId=${run.id} sessionId=${sessionId}`);
    } catch (err) {
      this.logger.error(`[ws][cloud] handleSubscribeChat error connId=${connId}: ${String(err)}`);
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
    const { chatId } = message;
    const prompt = message.prompt?.trim();

    if (!chatId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Chat ID required',
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
      // Resolve the latest run for the chat
      const validated = await this.resolveChatRun(connId, conn, chatId, { preferRunning: true });
      if (!validated) return;

      const { run, sessionId } = validated;

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
        const position = this.enqueueFollowUp(sessionId, { connId, prompt, runId: run.id });
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
          type: 'follow_up_status',
          runId: run.id,
          sessionId,
          status: 'queued',
          position,
        });

        this.logger.info(
          `[ws][cloud] follow-up queued connId=${connId} runId=${run.id} sessionId=${sessionId} position=${position}`,
        );
        return;
      }

      // Session is finished or errored - attempt resume/restart
      await this.resumeFollowUp(connId, run.id, sessionId, session as SessionRow, prompt);
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
   * Called from the session completion hook in service.ts.
   * Iterates the queue until a follow-up is successfully resumed or the queue is exhausted.
   */
  async processQueuedFollowUps(sessionId: string): Promise<void> {
    while (true) {
      const queue = this.followUpQueues.get(sessionId);
      if (!queue || queue.length === 0) {
        this.followUpQueues.delete(sessionId);
        return;
      }

      const entry = queue.shift()!;
      if (queue.length === 0) {
        this.followUpQueues.delete(sessionId);
      }

      // Skip entries whose connection has disconnected
      if (!this.wsManager.getConnection(entry.connId)) {
        this.logger.debug(
          `[ws][cloud] follow-up skipped: connection closed connId=${entry.connId} sessionId=${sessionId}`,
        );
        continue;
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
        return; // Successfully started, exit loop
      } catch (err) {
        this.logger.error(
          `[ws][cloud] processQueuedFollowUps error sessionId=${sessionId}: ${String(err)}`,
        );
        this.wsManager.sendToConnection(entry.connId, {
          type: 'error',
          code: ErrorCodes.SERVICE_ERROR,
          message: `Failed to process queued follow-up: ${String(err)}`,
        });
        // Continue loop to try next entry
      }
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
        type: 'follow_up_status',
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
        type: 'follow_up_status',
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
  private async resolveChatRun(
    connId: string,
    conn: WSConnection,
    chatId: string,
    opts: { preferRunning?: boolean; requireRunning?: boolean },
  ) {
    const normalized = this.normalizeChatId(chatId);
    if (!normalized) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.INVALID_MESSAGE,
        message: 'Valid chatId is required',
      });
      return null;
    }

    const virtualChatId = this.buildVirtualChatId(conn.identityId!, normalized);
    const session = await this.getLatestSessionForChatId(virtualChatId, Boolean(opts.preferRunning));
    if (!session) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: 'Chat session not found',
      });
      return null;
    }

    if (opts.requireRunning && !['starting', 'running'].includes(session.status)) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: 'No active run for this chat',
      });
      return null;
    }

    const run = await getCloudRunBySession(this.db, session.id);
    if (!run) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.SESSION_NOT_FOUND,
        message: 'Run not found for chat session',
      });
      return null;
    }

    const dbIdentityId = await this.identityResolver.resolve(conn.identityId!);
    if (run.identity_id !== dbIdentityId) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.ACCESS_DENIED,
        message: 'You do not have access to this chat',
      });
      return null;
    }

    return { run, sessionId: session.id };
  }

  private async getLatestSessionForChatId(virtualChatId: string, preferRunning: boolean): Promise<SessionRow | null> {
    if (preferRunning) {
      const running = await getLatestSessionForChat(this.db, 'websocket', virtualChatId, ['starting', 'running']);
      if (running) return running as SessionRow;
    }
    const latest = await getLatestSessionForChat(this.db, 'websocket', virtualChatId);
    return (latest as SessionRow) ?? null;
  }

  private normalizeChatId(chatId: string | undefined): string | null {
    if (!chatId) return null;
    const trimmed = chatId.trim();
    if (!trimmed) return null;
    if (trimmed.length > 64) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
    return trimmed;
  }

  private buildVirtualChatId(identityId: string, chatId: string): string {
    return `ws:${identityId}:${chatId}`;
  }

  private async assertIdentitySessionLimits(connId: string, identityId: string): Promise<boolean> {
    const maxTotal = this.config.security.max_sessions_per_identity;
    const maxConcurrent = this.config.security.max_concurrent_sessions_per_identity;

    const total = await countSessionsForUser(this.db, 'websocket', identityId);
    if (total >= maxTotal) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.RATE_LIMIT,
        message: 'Session limit reached for this identity',
      });
      return false;
    }

    const concurrent = await countConcurrentSessionsForUser(this.db, 'websocket', identityId);
    if (concurrent >= maxConcurrent) {
      this.wsManager.sendToConnection(connId, {
        type: 'error',
        code: ErrorCodes.RATE_LIMIT,
        message: 'Concurrent session limit reached for this identity',
      });
      return false;
    }
    return true;
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

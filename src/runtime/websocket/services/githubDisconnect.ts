import crypto from 'node:crypto';
import type { Logger } from '../../log.js';
import type { Db } from '../../db.js';
import type { AppConfig } from '../../config.js';
import type { WebSocketManager } from '../manager.js';
import type { CloudManager } from '../../cloud/manager.js';
import type { GitHubDisconnectMessage } from '../types.js';
import { IdentityResolver } from './identity.js';
import { createPendingAction, consumePendingAction } from '../../cloud/store.js';
import {
  findAllGithubConnections,
  computeGithubDisconnectImpact,
  executeGithubDisconnect,
} from '../../cloud/githubOauthDisconnect.js';

const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACTION_NAME = 'github_oauth_disconnect';

export class GitHubDisconnectService {
  private readonly identityResolver: IdentityResolver;

  constructor(
    private readonly wsManager: WebSocketManager,
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly logger: Logger,
    private readonly cloudManager: CloudManager | null,
  ) {
    this.identityResolver = new IdentityResolver(db);
  }

  async handleGitHubDisconnect(
    connId: string,
    identityId: string,
    msg: GitHubDisconnectMessage,
  ): Promise<void> {
    const cloud = this.config.cloud;
    if (!cloud?.enabled) {
      this.wsManager.sendToConnection(connId, {
        type: 'github_disconnect_response',
        action: 'error',
        error: 'Cloud features not enabled',
      });
      return;
    }

    try {
      const dbIdentityId = await this.identityResolver.resolve(identityId);

      if (msg.action === 'preview') {
        await this.handlePreview(connId, dbIdentityId);
      } else if (msg.action === 'confirm') {
        await this.handleConfirm(connId, dbIdentityId, msg.token);
      } else {
        this.wsManager.sendToConnection(connId, {
          type: 'github_disconnect_response',
          action: 'error',
          error: 'Invalid action',
        });
      }
    } catch (err) {
      this.logger.error(`[ws] github_disconnect error id=${connId}: ${String(err)}`);
      this.wsManager.sendToConnection(connId, {
        type: 'github_disconnect_response',
        action: 'error',
        error: String(err),
      });
    }
  }

  private async handlePreview(connId: string, identityId: string): Promise<void> {
    const connections = await findAllGithubConnections(this.db, identityId);
    if (connections.length === 0) {
      this.wsManager.sendToConnection(connId, {
        type: 'github_disconnect_response',
        action: 'error',
        error: 'No GitHub connection found',
      });
      return;
    }

    const connectionIds = connections.map(c => c.id);
    const impact = await computeGithubDisconnectImpact(this.db, connectionIds);

    const token = crypto.randomBytes(24).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    await createPendingAction(this.db, {
      action: ACTION_NAME,
      identityId,
      tokenHash,
      payloadJson: JSON.stringify({ connectionIds }),
      ttlMs: CONFIRM_TOKEN_TTL_MS,
    });

    this.logger.info(`[ws] github_disconnect preview id=${connId} connections=${connectionIds.length} repos=${impact.repos} runs=${impact.runs}`);

    this.wsManager.sendToConnection(connId, {
      type: 'github_disconnect_response',
      action: 'preview',
      impact,
      confirmToken: token,
      expiresIn: CONFIRM_TOKEN_TTL_MS,
    });
  }

  private async handleConfirm(connId: string, identityId: string, token?: string): Promise<void> {
    if (!token) {
      this.wsManager.sendToConnection(connId, {
        type: 'github_disconnect_response',
        action: 'error',
        error: 'Missing confirmation token',
      });
      return;
    }

    const cloud = this.config.cloud!;

    // Validate token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const pending = await consumePendingAction(this.db, {
      action: ACTION_NAME,
      identityId,
      tokenHash,
    });

    if (!pending) {
      this.wsManager.sendToConnection(connId, {
        type: 'github_disconnect_response',
        action: 'error',
        error: 'Invalid or expired confirmation token',
      });
      return;
    }

    // Parse payload
    let payload: { connectionIds: string[] };
    try {
      payload = JSON.parse(pending.payload_json);
    } catch {
      this.wsManager.sendToConnection(connId, {
        type: 'github_disconnect_response',
        action: 'error',
        error: 'Invalid token payload',
      });
      return;
    }

    // Execute disconnect
    const impact = await executeGithubDisconnect({
      db: this.db,
      cloud,
      logger: this.logger,
      connectionIds: payload.connectionIds,
      identityId,
      cloudManager: this.cloudManager,
    });

    this.logger.info(`[ws] github_disconnect completed id=${connId} repos=${impact.repos} runs=${impact.runs}`);

    this.wsManager.sendToConnection(connId, {
      type: 'github_disconnect_response',
      action: 'result',
      success: true,
      impact,
    });
  }
}

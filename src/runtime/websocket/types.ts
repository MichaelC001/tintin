import type { CloudRunWsStatus as CloudRunStatus, BrowserProvider } from '../cloud/types.js';

// Re-export types for backward compatibility
export type { CloudRunStatus, BrowserProvider };

// ============ Client → Server Messages ============

export interface AuthMessage {
  type: 'auth';
  token?: string;
}

export interface ChatMessage {
  type: 'chat';
  sessionId?: string;
  projectId?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}

export interface StopMessage {
  type: 'stop';
  sessionId: string;
}

export interface SubscribeMessage {
  type: 'subscribe';
  sessionId: string;
}

export interface UnsubscribeMessage {
  type: 'unsubscribe';
  sessionId: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface GetConnectionsMessage {
  type: 'get_connections';
}

export interface ListReposMessage {
  type: 'list_repos';
  provider?: string;  // 'github' | 'gitlab'
  search?: string;
}

export interface GetAuthStatusMessage {
  type: 'get_auth_status';
  provider: 'github' | 'gitlab';
}

export interface StartOAuthMessage {
  type: 'start_oauth';
  provider: 'github' | 'gitlab';
}

// ============ Cloud Run Messages (Client → Server) ============

export interface CloudRunMessage {
  type: 'cloud_run';
  repoIds?: string[];              // repo IDs (empty array = playground mode)
  prompt: string;                  // user prompt
  agent?: 'codex' | 'claude_code'; // optional, defaults from config
  restoreSnapshotId?: string;      // optional, restore from specified snapshot
  autoRestore?: boolean;           // optional, auto-restore from latest snapshot
  lastRunId?: string;              // optional, restore from specific run's snapshot
}

export interface SubscribeRunMessage {
  type: 'subscribe_run';
  runId: string;
}

export type ClientMessage =
  | AuthMessage
  | ChatMessage
  | StopMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | PingMessage
  | GetConnectionsMessage
  | ListReposMessage
  | GetAuthStatusMessage
  | StartOAuthMessage
  | CloudRunMessage
  | SubscribeRunMessage;

// ============ Server → Client Messages ============

export interface AuthOkMessage {
  type: 'auth_ok';
  identityId?: string;
}

export interface AuthErrorMessage {
  type: 'auth_error';
  message: string;
}

export interface SessionStartedMessage {
  type: 'session_started';
  sessionId: string;
  runId?: string;
}

export interface ChunkMessage {
  type: 'chunk';
  sessionId: string;
  content: string;
}

export interface ToolCallMessage {
  type: 'tool_call';
  sessionId: string;
  name: string;
  input?: string;
}

export interface ToolOutputMessage {
  type: 'tool_output';
  sessionId: string;
  name: string;
  output: string;
}

export interface AgentEventMessage {
  type: 'agent_event';
  sessionId: string;
  command: string;
  subcommand: string;
  request: {
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    meta?: unknown;
    upload_bytes?: number;
  };
  response: {
    status: number;
    body?: unknown;
    text?: string;
    error?: string;
  };
}

export interface PlanUpdateMessage {
  type: 'plan_update';
  sessionId: string;
  plan: Array<{
    step: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed';
  }>;
  explanation?: string;
}

export interface DoneMessage {
  type: 'done';
  sessionId: string;
  stopped?: boolean;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ErrorMessage {
  type: 'error';
  sessionId?: string;
  code?: string;
  message: string;
}

export interface PongMessage {
  type: 'pong';
}

export interface ConnectionsListMessage {
  type: 'connections_list';
  connections: Array<{
    id: string;
    type: string;
    installationId?: string;
    accountLogin?: string;
    status?: string;
    createdAt: number;
  }>;
}

export interface ReposListMessage {
  type: 'repos_list';
  repos: Array<{
    id: string;
    name: string;
    url: string;
    provider: string;
    defaultBranch: string | null;
  }>;
  total: number;
}

export interface AuthStatusMessage {
  type: 'auth_status';
  provider: string;
  connected: boolean;
  accountLogin?: string;
  installationId?: string;
}

export interface OAuthStartedMessage {
  type: 'oauth_started';
  provider: string;
  authorizeUrl: string;
}

// ============ Cloud Run Messages (Server → Client) ============

export interface RunStatusMessage {
  type: 'run_status';
  runId: string;
  status: CloudRunStatus;
  message?: string;
}

export interface RunLinksMessage {
  type: 'run_links';
  runId: string;
  sessionId: string;
  viewUrl?: string;
  codeProxyUrl?: string;
  vscodeUrl?: string;
}

export interface BrowserSessionMessage {
  type: 'browser_session';
  sessionId: string;
  runId: string;
  cdpUrl: string;
  provider: BrowserProvider;
}

export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | SessionStartedMessage
  | ChunkMessage
  | ToolCallMessage
  | ToolOutputMessage
  | AgentEventMessage
  | PlanUpdateMessage
  | DoneMessage
  | ErrorMessage
  | PongMessage
  | ConnectionsListMessage
  | ReposListMessage
  | AuthStatusMessage
  | OAuthStartedMessage
  | RunStatusMessage
  | RunLinksMessage
  | BrowserSessionMessage
  | SandboxStatusMessage
  | SandboxReadyMessage
  | SandboxErrorMessage;

// ============ Error Codes ============

export const ErrorCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  RATE_LIMIT: 'RATE_LIMIT',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  SERVICE_ERROR: 'SERVICE_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// ============ Connection Sandbox State ============

/**
 * Sandbox status for a WebSocket connection.
 * - provisioning: Workspace is being created
 * - ready: Workspace is ready for use
 * - in_use: An agent run is active in the sandbox
 * - terminating: Workspace is being terminated
 * - error: Sandbox provisioning or operation failed
 */
export type ConnectionSandboxStatus =
  | 'provisioning'
  | 'ready'
  | 'in_use'
  | 'terminating'
  | 'error';

/**
 * Represents a sandbox (workspace) tied to a WebSocket connection.
 * Created on auth success, destroyed on disconnect.
 */
export interface ConnectionSandbox {
  workspaceId: string;
  rootPath: string;
  status: ConnectionSandboxStatus;
  runId: string | null;
  sessionId: string | null;
  dbIdentityId: string;
  createdAt: number;
  error: string | null;
}

// ============ Sandbox Messages (Server → Client) ============

export interface SandboxStatusMessage {
  type: 'sandbox_status';
  status: ConnectionSandboxStatus;
  workspaceId?: string;
  message?: string;
}

export interface SandboxReadyMessage {
  type: 'sandbox_ready';
  workspaceId: string;
}

export interface SandboxErrorMessage {
  type: 'sandbox_error';
  message: string;
  recoverable: boolean;
}

// ============ Connection State ============

export interface WSConnection {
  id: string;
  ws: import('ws').WebSocket;
  identityId: string | null;
  authenticated: boolean;
  subscribedSessions: Set<string>;
  lastPingAt: number;
  lastActivityAt: number;
  createdAt: number;
  messageCount: number;
  sandbox: ConnectionSandbox | null;
}

// ============ WebSocket Config ============

export interface WebSocketSection {
  enabled: boolean;
  path: string;
  auth_enabled: boolean;
  auth_secret?: string;
  ping_interval_ms: number;
  connection_timeout_ms: number;
  auth_timeout_ms: number;
  max_connections: number;
  max_connections_per_identity: number;
  max_message_size: number;
  rate_limit_messages_per_sec: number;
}

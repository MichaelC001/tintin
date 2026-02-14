# Tintin - Module Reference

Detailed documentation of all modules with LOC, responsibilities, and key exports.

## Core Modules (`src/runtime/`)

### service.ts (526 LOC)
HTTP server & bot initialization

**Responsibilities:**
- Express server setup
- Bot webhook endpoints
- UI static file serving

**Key Exports:**
```typescript
function start(config: Config): Promise<void>
function createServer(config: Config): Express
```

### controller2.ts (367 LOC)
Central BotController - dispatches to platform-specific handlers

**Responsibilities:**
- Platform dispatch (Telegram/Slack/WebSocket)
- Command routing
- Session coordination
- Cloud run initiation

**Key Exports:**
```typescript
class BotController {
    handleChat(platform, identityId, content): Promise<void>
    handleInteraction(platform, interaction): Promise<void>
    handleCloudRun(identityId, repoIds, prompt): Promise<void>
}
```

### sessionManager.ts (1174 LOC)
Agent session lifecycle management

**Responsibilities:**
- Spawn agent processes (Codex/Claude Code)
- Monitor JSONL output
- Handle termination
- State transitions

**Key Exports:**
```typescript
class SessionManager {
    startNew(identityId, agentType, prompt): Promise<Session>
    resumeSession(sessionId): Promise<Session>
    kill(sessionId): Promise<void>
    getSessionStatus(sessionId): Promise<SessionStatus>
}
```

### streamer.ts
JSONL stream processing re-export

**Key Exports:**
```typescript
export { JsonlStreamer } from './streamer/JsonlStreamer'
export { ToolCallManager } from './streamer/ToolCallManager'
```

### agents.ts
Agent adapter interface

**Key Exports:**
```typescript
interface AgentAdapter {
    spawnExec(params): Promise<ChildProcess>
    monitor(process, onOutput): Promise<void>
}
```

### codex.ts (433 LOC)
Codex CLI adapter

**Responsibilities:**
- Codex CLI process spawning
- JSONL stdout parsing
- Process lifecycle

### claudeCode.ts (422 LOC)
Claude Code CLI adapter

**Responsibilities:**
- Claude Code CLI process spawning
- JSONL stdout parsing
- Process lifecycle

### config.ts (1043 LOC)
TOML configuration loader

**Responsibilities:**
- Parse config.toml
- Environment variable expansion
- Validation

**Key Exports:**
```typescript
function load(path: string): Promise<Config>
function expandEnv(value: string): string
```

### db.ts (567 LOC)
Database types & connection

**Responsibilities:**
- Kysely connection setup
- Type definitions

**Key Exports:**
```typescript
function createConnection(config): Promise<Kysely<Database>>
interface Database { ... }
```

### store.ts (366 LOC)
Data access layer

**Responsibilities:**
- Session CRUD
- Identity queries
- Connection management
- WebSocket identity resolution

**Key Exports:**
```typescript
function resolveWebIdentityId(db, wsIdentityId): Promise<string>
```

### messaging.ts
Platform message sending abstraction

**Key Exports:**
```typescript
interface IMessagingPlatform {
    sendMessage(chatId, text): Promise<void>
    sendPhoto(chatId, photo): Promise<void>
}
```

### httpClient.ts
HTTP client utilities

### log.ts
Logging utilities

**Key Exports:**
```typescript
function createLogger(name: string): Logger
```

### util.ts
Shared utilities

**Key Exports:**
```typescript
class RateLimiter { ... }
class TaskQueue { ... }
```

## Controller Modules (`src/runtime/controller/`)

### telegramHandler.ts (1138 LOC)
Telegram-specific handling

**Responsibilities:**
- Telegram command parsing
- Callback query handling
- Inline interactions
- Media handling

**Key Commands:**
- `/start`, `/help`
- `/new`, `/resume`, `/kill`
- `/cloud_run`, `/cloud_status`

### slackHandler.ts (512 LOC)
Slack-specific handling

**Responsibilities:**
- Slack command parsing
- Shortcut handling
- Modal interactions

### cloudHandler.ts (1671 LOC)
Cloud command handling

**Responsibilities:**
- `cloud_help` - Show cloud commands
- `cloud_status` - Show current runs
- `cloud_kill` - Kill a run
- `cloud_logs` - Fetch logs

### interactionHandler.ts (511 LOC)
Shared interaction handling

**Responsibilities:**
- Button click handling
- Selection handling
- Response routing

### commands.ts (529 LOC)
Command parsing utilities

**Key Exports:**
```typescript
function parseCommand(text): ParsedCommand | null
function parseArgs(args): ParsedArgs
```

### sessions.ts (276 LOC)
Session management commands

**Key Exports:**
```typescript
function handleNew(identityId, args): Promise<void>
function handleResume(identityId, args): Promise<void>
function handleKill(identityId, args): Promise<void>
```

### settings.ts (468 LOC)
Settings management commands

**Key Features:**
- Language preference
- Message verbosity
- Branch naming rules

## Session Modules (`src/runtime/session/`)

### SessionStateMachine.ts
State transition validation

**Valid Transitions:**
```
wizard   → starting
starting → running | error | killed
running  → finished | error | killed
```

### ProcessLifecycleManager.ts
Process registration, timeouts, termination

**Key Exports:**
```typescript
class ProcessLifecycleManager {
    register(pid, sessionId): void
    kill(sessionId): Promise<void>
    killAll(): Promise<void>
}
```

### ChatGptProxyManager.ts (350 LOC)
ChatGPT OAuth proxy process lifecycle

### EnvironmentBuilder.ts
Fluent env var builder

**Usage:**
```typescript
const env = EnvironmentBuilder.create()
    .withLanguage('zh')
    .withCloudProxy(config.cloud.proxyUrl)
    .withChatGptProxy(true)
    .withMcpServers(servers)
    .build();
```

## Streamer Modules (`src/runtime/streamer/`)

### JsonlStreamer.ts (840 LOC)
Main streaming logic

**Responsibilities:**
- Poll JSONL file
- Convert to StreamFragment
- Rate limiting
- Chunking

**Key Exports:**
```typescript
class JsonlStreamer {
    pollOnce(): Promise<StreamFragment[]>
    start(onFragment): void
    stop(): void
}
```

### ToolCallManager.ts (77 LOC)
Tool call/output pairing queue

**Key Exports:**
```typescript
class ToolCallManager {
    push(call): void
    shift(): { call, output } | null
}
```

### PlanUpdateHandler.ts (180 LOC)
Plan update parsing

### PlaywrightScreenshotManager.ts (456 LOC)
Browser screenshots via MCP

### eventMappers/ (1190 LOC total)
Agent-specific event mapping

**Files:**
- `claudeMapper.ts` (183 LOC) - Claude Code JSONL event → StreamFragment
- `codexMapper.ts` (275 LOC) - Codex JSONL event → StreamFragment
- `helpers.ts` (428 LOC) - Shared mapping utilities, text formatting, tool output formatting
- `messageDispatcher.ts` (304 LOC) - Routes fragments to platform/WebSocket destinations

## Cloud Execution (`src/runtime/cloud/`)

### manager.ts (4699 LOC)
Cloud run orchestration

**Responsibilities:**
- Workspace creation
- File uploads
- Execution
- Snapshots
- Cleanup

**Key Exports:**
```typescript
class CloudManager {
    startRun(params): Promise<CloudRun>
    getLogs(runId): Promise<LogEntry[]>
    snapshot(runId): Promise<Snapshot>
    kill(runId): Promise<void>
}
```

### modalProvider.ts (395 LOC)
Modal sandbox provider

**Key Exports:**
```typescript
class ModalProvider implements CloudProvider {
    createSandbox(params): Promise<Sandbox>
    execute(sandbox, command): Promise<Result>
}
```

### localProvider.ts (124 LOC)
Local provider for testing

### store.ts (1508 LOC)
Cloud data access layer

### repos.ts (152 LOC)
Centralized repository sync logic

**Responsibilities:**
- Fetch GitHub personal repos (paginated)
- Fetch GitHub App installation repos
- Sync all repos for an identity with stale indicator
- Fetch GitLab repos

**Key Exports:**
```typescript
function syncReposForIdentity(db, identityId, connections): Promise<{ stale: boolean }>
function fetchGithubRepos(token): Promise<Repo[]>
function fetchGithubInstallationRepos(installationId): Promise<Repo[]>
function fetchGitlabRepos(token): Promise<Repo[]>
```

### githubApp.ts (375 LOC)
GitHub App integration

**Key Exports:**
```typescript
function parseGithubAppMetadata(metadata): { installation_id, account_login, account_type }
function isGithubInstallationMissing(installationId): Promise<boolean>
```

### githubWebhook.ts (572 LOC)
GitHub webhook processing

### notion/ (NEW)
Notion MCP OAuth integration

**Files:**
- `discovery.ts` - MCP server discovery
- `oauth.ts` - Notion OAuth flow
- `registration.ts` - Server registration
- `token.ts` - Token management

## HTTP Service (`src/runtime/service/`)

### httpServer.ts (593 LOC)
HTTP server setup & route mounting

**Responsibilities:**
- Express server configuration
- Route registration
- Middleware setup
- Static file serving

### sessionMessenger.ts (752 LOC)
Platform message formatting & WebSocket routing

**Responsibilities:**
- Format StreamFragment for platform delivery (Telegram/Slack/WebSocket)
- Route tool_call and tool_output messages to WebSocket subscribers
- Verbosity-based message filtering
- Platform-specific message adaptation

**Key Exports:**
```typescript
class SessionMessenger {
    sendToSession(sessionId, fragment): Promise<void>
    hasSubscribers(sessionId): boolean
}
```

## HTTP API (`src/runtime/service/http/`)

### githubRoutes.ts (487 LOC)
GitHub HTTP REST API endpoints

**Responsibilities:**
- GitHub auth status check
- Repository listing with search/filter
- GitHub OAuth initiation (OAuth + App flows)
- Two-phase GitHub disconnect with confirmation
- Connection listing

**Endpoints:**
- `GET /api/github/auth-status` - Connection status and account login
- `GET /api/github/repos` - List repos with search and provider filter
- `POST /api/github/oauth/start` - Initiate GitHub OAuth or App flow
- `POST /api/github/disconnect` - Two-step disconnect (preview/confirm)
- `GET /api/github/connections` - List all OAuth/App connections

**Authentication:** Bearer token via `cloud.proxy.shared_secret`

### agentRoutes.ts (888 LOC)
Agent log relay & execution API endpoints

**Responsibilities:**
- Agent log relay from JSONL to HTTP streaming
- Cloud run execution API
- Session event broadcasting

### cloudApiRoutes.ts (440 LOC)
Cloud API endpoints

**Responsibilities:**
- Cloud run management API
- Workspace status queries
- Deployment management

## WebSocket Communication (`src/runtime/websocket/`)

### manager.ts (400 LOC)
Connection management

### handler.ts (256 LOC)
Agent execution message routing & authentication

**Message Types:**
- `auth` - Authentication
- `cloud_run` - Start cloud run
- `subscribe_chat` - Subscribe to chat updates
- `cloud_follow_up` - Follow-up prompts
- `cloud_stop` - Stop execution

### services/cloud.ts (827 LOC)
CloudRunService

### services/identity.ts
IdentityResolver

### services/linkBuilder.ts
URL builder for run links

### services/sandboxLifecycle.ts (216 LOC)
Sandbox provisioning

## MCP Integration (`src/runtime/mcp/`)

### registry.ts
MCP server registry

**Key Exports:**
```typescript
class McpRegistry {
    register(name, provider): void
    startAll(): Promise<void>
    stopAll(): Promise<void>
    get(name): IMcpProvider
}
```

### factory.ts
Provider factory

### activation.ts (136 LOC)
MCP server activation logic

### config.ts (208 LOC)
MCP configuration parsing

### schemas.ts (122 LOC)
JSON schemas for MCP tool validation

### providers/
- `base.ts` - Base provider class
- `stdio.ts` - Stdio transport
- `http.ts` - HTTP transport
- `github.ts` - GitHub MCP
- `exa.ts` - Exa search API integration
- `parallel.ts` - Parallel execution provider
- `playwright/` - Playwright browser automation MCP

## Platform Adapters (`src/runtime/platform/`)

### telegram.ts (999 LOC)
Telegram client

**Key Exports:**
```typescript
class TelegramPlatform implements IMessagingPlatform {
    sendMessage(chatId, text): Promise<void>
    sendPhoto(chatId, photo, caption): Promise<void>
    answerCallback(queryId, data): Promise<void>
}
```

### slack.ts (804 LOC)
Slack client

**Key Exports:**
```typescript
class SlackPlatform implements IMessagingPlatform {
    postMessage(channel, text): Promise<void>
    update(responseUrl, text): Promise<void>
    openView(triggerId, view): Promise<void>
}
```

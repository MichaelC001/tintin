# Tintin - Module Reference

Detailed documentation of all modules with LOC, responsibilities, and key exports.

## Core Modules (`src/runtime/`)

### service.ts (563 LOC)
HTTP server & bot initialization

**Responsibilities:**
- Express server setup
- OAuth callbacks (GitHub, Slack, Notion)
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

### sessionManager.ts (1084 LOC)
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

### config.ts (1027 LOC)
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

### db.ts (536 LOC)
Database types & connection

**Responsibilities:**
- Kysely connection setup
- Type definitions

**Key Exports:**
```typescript
function createConnection(config): Promise<Kysely<Database>>
interface Database { ... }
```

### store.ts (345 LOC)
Data access layer

**Responsibilities:**
- Session CRUD
- Identity queries
- Connection management

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

### cloudHandler.ts (1536 LOC)
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

### commands.ts (497 LOC)
Command parsing utilities

**Key Exports:**
```typescript
function parseCommand(text): ParsedCommand | null
function parseArgs(args): ParsedArgs
```

### sessions.ts (265 LOC)
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

### JsonlStreamer.ts (843 LOC)
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

### ToolCallManager.ts
Tool call/output pairing queue

**Key Exports:**
```typescript
class ToolCallManager {
    push(call): void
    shift(): { call, output } | null
}
```

### PlanUpdateHandler.ts
Plan update parsing

### PlaywrightScreenshotManager.ts (456 LOC)
Browser screenshots via MCP

## Cloud Execution (`src/runtime/cloud/`)

### manager.ts (4533 LOC)
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

### localProvider.ts (4932 LOC)
Local provider for testing

### store.ts (1390 LOC)
Cloud data access layer

### githubApp.ts (307 LOC)
GitHub App integration

### githubWebhook.ts (563 LOC)
GitHub webhook processing

### notion/ (NEW)
Notion MCP OAuth integration

**Files:**
- `discovery.ts` - MCP server discovery
- `oauth.ts` - Notion OAuth flow
- `registration.ts` - Server registration
- `token.ts` - Token management

## WebSocket Communication (`src/runtime/websocket/`)

### manager.ts (412 LOC)
Connection management

### handler.ts (306 LOC)
Message routing & authentication

**Message Types:**
- `auth` - Authentication
- `chat` - Chat message
- `cloud_run` - Start cloud run
- `subscribe_run` - Subscribe to run updates

### services/cloud.ts (714 LOC)
CloudRunService

### services/github.ts (342 LOC)
GitHubService

### services/identity.ts
IdentityResolver

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

### providers/
- `stdio.ts` - Stdio transport
- `http.ts` - HTTP transport
- `github.ts` - GitHub MCP
- `playwright/` - Playwright MCP

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

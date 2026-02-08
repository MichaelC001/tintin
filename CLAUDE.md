# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tintin is a chat-based control interface (Telegram/Slack/WebSocket) for coding agents (Codex and Claude Code). It allows users to trigger coding tasks, run code, interact with repositories, and view results directly from chat platforms. Supports both local execution and cloud execution via Modal sandboxes, with Cloud Proxy support for CLI agents. Features modular architecture with platform-specific handlers, Model Context Protocol (MCP) integration, and multi-language support.

## Build & Test Commands

```bash
npm run build          # TypeScript compilation (tsc -p tsconfig.build.json)
npm run typecheck      # Type validation without emitting
npm run test           # Build + run tests (Node.js built-in test runner)
npm run start          # Run daemon directly
npm run migrate        # Run database migrations

# Single test file
npm run build && node --test dist/tests/cloud-config.test.js

# Run specific module tests
npm run build && node --test dist/tests/streamer/*.test.js
npm run build && node --test dist/tests/session/*.test.js

# CLI access (after build)
node dist/tintin.js start|stop|status|log|restart
node dist/tinc.js lift|pull|attach
```

## Architecture

### System Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        User Interface Layer                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ Telegram │  │  Slack   │  │WebSocket │  │      Cloud UI          │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬───────────────┘ │
└───────┼─────────────┼─────────────┼─────────────────┼─────────────────┘
        │             │             │                  │
        └─────────────┴──────┬──────┴──────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────────────────┐
│                      Service Layer                                     │
│                             │                                           │
│  ┌──────────────────────────▼───────────────────────────────────────┐  │
│  │                   service.ts (HTTP Server)                       │  │
│  │  OAuth Callbacks · UI Endpoints · Bot Webhooks                    │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
│                             │                                           │
│  ┌──────────────────────────▼───────────────────────────────────────┐  │
│  │                   controller2.ts (BotController)                  │  │
│  │  Platform Dispatch · Command Routing · Session Coordination      │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
│                             │                                           │
│  ┌──────────────────────────▼───────────────────────────────────────┐  │
│  │                   controller/ (Modular Handlers)                  │  │
│  │  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐            │  │
│  │  │telegramHandler│ │  slackHandler │ │cloudHandler   │            │  │
│  │  └───────────────┘ └───────────────┘ └───────────────┘            │  │
│  │  ┌───────────────┐ ┌───────────────┐                              │  │
│  │  │interactionHdlr│ │   commands    │                              │  │
│  │  └───────────────┘ └───────────────┘                              │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
└─────────────────────────────┼────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼────────────────────────────────────────────┐
│           Execution Layer                     Integration Layer           │
│                             │                                           │
│  ┌────────────▼──────────┐  │  ┌─────────────────────────────────────┐ │
│  │   SessionManager      │  │  │        McpRegistry                  │ │
│  │  ┌─────────────────┐  │  │  │  ┌──────────┐  ┌────────────────┐  │ │
│  │  │State Machine    │  │  │  │  │  stdio   │  │    playwright   │  │ │
│  │  │Process Lifecycle│  │  │  │  │  http    │  │       github     │  │ │
│  │  │Env Builder      │  │  │  │  │  notion  │  │       notion     │  │ │
│  │  │ChatGPT Proxy    │  │  │  │  └──────────┘  └────────────────┘  │ │
│  │  └─────────────────┘  │  │  │  └─────────────────────────────────┘ │
│  └────────┬─────────────┘  │  └─────────────────────────────────────────┘ │
│           │                 │
│  ┌────────▼──────────────┐  │  ┌──────────────────────────────────────┐ │
│  │    CloudManager       │  │  │      WebSocketHandler                │ │
│  │  ┌────────────────┐   │  │  │  ┌──────────────┐  ┌─────────────┐ │ │
│  │  │ModalProvider   │   │  │  │  │ CloudService │  │GitHubService│ │ │
│  │  │LocalProvider   │   │  │  │  │SessionService│  │IdentitySvc  │ │ │
│  │  │GitHub App/OAuth│   │  │  │  └──────────────┘  └─────────────┘ │ │
│  │  └────────────────┘   │  │  └──────────────────────────────────────┘ │
│  └───────────────────────┘  │                                           │
└─────────────────────────────┼────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼────────────────────────────────────────────┐
│           Agent Layer              Stream Layer                          │
│                             │                                           │
│  ┌────────▼──────────────┐  │  ┌─────────────────────────────────────┐ │
│  │   AgentAdapter        │  │  │        JsonlStreamer                │ │
│  │  ┌────────────────┐   │  │  │  ┌──────────────┐  ┌──────────────┐│ │
│  │  │   CodexAgent   │   │  │  │  │ToolCallMgr   │  │PlanUpdateHdlr││ │
│  │  │  ClaudeAgent   │   │  │  │  └──────────────┘  └──────────────┘│ │
│  │  └────────────────┘   │  │  │  ┌─────────────────────────────────┐│ │
│  └────────┬──────────────┘  │  │  │PlaywrightScreenshotManager      ││ │
│           │ JSONL Output    │  │  └─────────────────────────────────┘│ │
└───────────┼─────────────────┴  └──────────────────┬──────────────────┘ │
            │                                     │ StreamFragment        │
┌───────────┼─────────────────────────────────────┼──────────────────────┘
            │           Storage Layer             │
│  ┌────────▼──────────┐  ┌───────────┐  ┌────────▼────────┐
│  │  Database (Kysely)│  │ JSONL     │  │  S3 Artifacts   │
│  │  - sessions       │  │ Files     │  │  - screenshots  │
│  │  - identities     │  │           │  │  - artifacts    │
│  │  - cloud_runs     │  │           │  │                 │
│  └───────────────────┘  └───────────┘  └─────────────────┘
└────────────────────────────────────────────────────────────────────────┘
```

### Module Dependency Graph

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        controller2.ts (BotController)                  │
│  Platform dispatch · Command routing · Session coordination            │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬─────────────────────┐
        │                   │                   │                     │
        ▼                   ▼                   ▼                     ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐
│controller/    │  │sessionManager │  │cloudManager   │  │websocket/       │
│               │  │               │  │               │  │handler.ts       │
│┌─────────────┐│  │┌─────────────┐│  │┌─────────────┐│  │┌──────────────┐│
││telegramHdlr ││  ││session/     ││  ││modalProvider││  ││services/     ││
││slackHandler││  ││  StateMachine││  ││localProvider││  ││  cloud.ts    ││
││cloudHandler ││  ││  ProcessMgr  ││  ││store.ts     ││  ││  session.ts  ││
││interaction  ││  ││  EnvBuilder  ││  ││githubApp.ts ││  ││  github.ts   ││
││  Handler    ││  ││  ChatGPTProxy││  ││webhook.ts   ││  ││  identity.ts ││
││commands.ts  ││  │└─────────────┘│  │└─────────────┘│  │└──────────────┘│
│└─────────────┘│  └───────────────┘  └───────────────┘  └─────────────────┘
└───────────────┘
        │                   │                   │                     │
        └───────────────────┴───────────────────┴─────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬─────────────────────┐
        │                   │                   │                     │
        ▼                   ▼                   ▼                     ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌─────────────────┐
│agents.ts      │  │streamer/      │  │mcp/           │  │platform/        │
│┌─────────────┐│  │┌─────────────┐│  │┌─────────────┐│  │┌──────────────┐│
││codex.ts     ││  ││JsonlStreamer││  ││registry.ts  ││  ││telegram.ts   ││
││claudeCode.ts││  ││ToolCallMgr  ││  ││factory.ts   ││  ││slack.ts      ││
│└─────────────┘│  ││PlanUpdateHdlr││  ││providers/   ││  │└──────────────┘│
└───────────────┘  ││eventMappers/││  ││  stdio/http ││  └─────────────────┘
                  │└─────────────┘│  ││  playwright ││
                  └───────────────┘  ││  github/notion││
                                     │└─────────────┘│
                                     └───────────────┘
```

### Component Responsibilities

| Module | Responsibility |
|--------|----------------|
| **controller2.ts** | Central BotController - dispatches to platform-specific handlers |
| **controller/** | Modular handlers for Telegram, Slack, Cloud, Interactions, Settings |
| **sessionManager.ts** | Agent session lifecycle - spawn, monitor, terminate |
| **session/** | State machine, process lifecycle, environment builder, ChatGPT proxy |
| **cloudManager.ts** | Cloud run orchestration - Modal/Local providers |
| **cloud/** | Providers, GitHub App/OAuth, Notion MCP, webhooks, storage |
| **websocket/handler.ts** | WebSocket message routing & authentication |
| **websocket/services/** | Cloud run, session, GitHub, identity services |
| **streamer/JsonlStreamer.ts** | JSONL to StreamFragment conversion |
| **streamer/** | Tool call pairing, plan updates, screenshots, event mappers |
| **mcp/registry.ts** | Model Context Protocol server registry & lifecycle |
| **mcp/providers/** | stdio, HTTP, Playwright, GitHub, Notion providers |
| **platform/** | Telegram & Slack client adapters |
| **service/** | HTTP server, session messaging, commit proposals, routes |

## File Structure

### Core Runtime (`src/runtime/`)

```
src/runtime/
├── Core Modules
│   ├── service.ts              # HTTP server & bot initialization
│   ├── controller2.ts          # Central BotController (367 LOC)
│   ├── sessionManager.ts       # Agent session lifecycle (1084 LOC)
│   ├── streamer.ts             # JSONL stream processing re-export
│   ├── agents.ts               # Agent adapter interface
│   ├── codex.ts                # Codex CLI adapter (433 LOC)
│   ├── claudeCode.ts           # Claude Code CLI adapter (422 LOC)
│   ├── config.ts               # TOML configuration loader (1027 LOC)
│   ├── db.ts                   # Database types & connection (536 LOC)
│   ├── store.ts                # Data access layer (345 LOC)
│   ├── messaging.ts            # Platform message sending
│   ├── httpClient.ts           # HTTP client utilities
│   ├── log.ts                  # Logging utilities
│   ├── util.ts                 # Shared utilities (RateLimiter, TaskQueue)
│   ├── prompt.ts               # Prompt building
│   ├── redact.ts               # Secret redaction
│   ├── typeGuards.ts           # Type guards
│   ├── security.ts             # Security utilities
│   ├── searchPolicy.ts         # Search policy
│   ├── pinecone.ts             # Pinecone integration
│   └── migrations.ts           # Migration runner
│
├── controller/                # Modular controller handlers (NEW)
│   ├── telegramHandler.ts     # Telegram-specific handling (1138 LOC)
│   ├── slackHandler.ts        # Slack-specific handling (512 LOC)
│   ├── cloudHandler.ts        # Cloud command handling (1536 LOC)
│   ├── interactionHandler.ts  # Interaction handling (511 LOC)
│   ├── commands.ts            # Command parsing (497 LOC)
│   ├── sessions.ts            # Session management (265 LOC)
│   ├── settings.ts            # Settings management (468 LOC)
│   ├── types.ts               # Controller types
│   └── utils.ts               # Controller utilities
│
├── streamer/                  # Modular streamer components
│   ├── JsonlStreamer.ts       # Main streaming logic (843 LOC)
│   ├── ToolCallManager.ts     # Tool call/output pairing queue
│   ├── PlanUpdateHandler.ts   # Plan update parsing
│   ├── PlaywrightScreenshotManager.ts # Browser screenshots (456 LOC)
│   ├── types.ts               # StreamFragment, MessageVerbosity
│   ├── index.ts               # Public exports
│   └── eventMappers/
│       ├── index.ts           # EVENT_MAPPERS registry
│       ├── helpers.ts         # Shared formatting utilities (428 LOC)
│       ├── codexMapper.ts     # Codex JSONL → StreamFragment (275 LOC)
│       ├── claudeMapper.ts    # Claude JSONL → StreamFragment
│       └── messageDispatcher.ts # event_msg handling (294 LOC)
│
├── session/                   # Modular session components
│   ├── SessionStateMachine.ts # State transition validation
│   ├── ProcessLifecycleManager.ts # Process registration/kill
│   ├── ChatGptProxyManager.ts # ChatGPT OAuth proxy (350 LOC)
│   ├── EnvironmentBuilder.ts  # Fluent env var builder
│   ├── types.ts               # SessionStatus, VALID_TRANSITIONS
│   └── index.ts               # Public exports
│
├── cloud/                     # Cloud execution (30+ files)
│   ├── manager.ts             # Cloud orchestration (4533 LOC)
│   ├── modalProvider.ts       # Modal sandbox provider (395 LOC)
│   ├── localProvider.ts       # Local provider (4932 LOC)
│   ├── proxy.ts               # Cloud proxy auth (284 LOC)
│   ├── store.ts               # Cloud data access (1390 LOC)
│   ├── oauth.ts               # OAuth handling
│   ├── githubApp.ts           # GitHub App integration (307 LOC)
│   ├── githubWebhook.ts       # GitHub webhook processing (563 LOC)
│   ├── githubDisconnect.ts    # GitHub App disconnect
│   ├── disconnectCleanup.ts   # Shared disconnect cleanup (299 LOC)
│   ├── browserbase.ts         # Browserbase integration
│   ├── hyperbrowser.ts        # Hyperbrowser integration
│   ├── notion/                # Notion MCP OAuth (NEW)
│   │   ├── discovery.ts       # MCP server discovery
│   │   ├── oauth.ts           # Notion OAuth flow
│   │   ├── registration.ts    # Server registration
│   │   └── token.ts           # Token management
│   ├── setupSpec.ts           # Setup specification (185 LOC)
│   ├── secrets.ts             # Secret management
│   ├── uiArtifacts.ts         # UI artifact handling (298 LOC)
│   ├── uiTokens.ts            # UI token management
│   ├── s3.ts                  # S3 operations
│   ├── repos.ts               # Repository operations
│   ├── git.ts                 # Git operations
│   ├── prompts.ts             # Cloud prompts
│   ├── types.ts               # Cloud types
│   └── provider.ts            # CloudProvider interface
│
├── websocket/                 # WebSocket communication
│   ├── manager.ts             # Connection management (412 LOC)
│   ├── handler.ts             # Message routing (306 LOC)
│   ├── guards.ts              # Auth guards
│   ├── types.ts               # Protocol definitions (407 LOC)
│   ├── index.ts               # Public exports
│   └── services/
│       ├── cloud.ts           # CloudRunService (714 LOC)
│       ├── github.ts          # GitHubService (342 LOC)
│       ├── githubDisconnect.ts # GitHub disconnect
│       ├── sandboxLifecycle.ts # Sandbox lifecycle (266 LOC)
│       ├── identity.ts        # IdentityResolver
│       ├── linkBuilder.ts     # URL construction
│       └── index.ts           # Public exports
│
├── mcp/                       # Model Context Protocol (12 files)
│   ├── registry.ts            # MCP server registry
│   ├── factory.ts             # Provider factory
│   ├── lifecycle.ts           # Server lifecycle
│   ├── config.ts              # MCP configuration
│   ├── bootstrap.ts           # Bootstrap config
│   ├── schemas.ts             # Zod schemas
│   ├── utils.ts               # MCP utilities
│   ├── types.ts               # MCP types
│   ├── index.ts               # Public exports
│   └── providers/
│       ├── base.ts            # Base provider
│       ├── stdio.ts           # Stdio transport
│       ├── http.ts            # HTTP transport
│       ├── github.ts          # GitHub MCP provider
│       ├── playwright/        # Playwright MCP
│       │   ├── index.ts       # Playwright provider (408 LOC)
│       │   ├── config.ts      # Playwright config (249 LOC)
│       │   └── types.ts       # Playwright types
│       └── index.ts           # Provider exports
│
├── platform/                  # Platform adapters (5 files)
│   ├── base.ts                # Platform interface
│   ├── basePlatform.ts        # Base platform client
│   ├── adapters.ts            # Adapter utilities
│   ├── telegram.ts            # Telegram client (999 LOC)
│   └── slack.ts               # Slack client (804 LOC)
│
├── service/                   # HTTP service layer
│   ├── httpServer.ts          # HTTP server (560 LOC)
│   ├── sessionMessenger.ts    # Session messaging (724 LOC)
│   ├── commitProposals.ts     # Commit proposals (367 LOC)
│   ├── http/                  # HTTP routes
│   │   ├── agentRoutes.ts     # Agent routes (888 LOC)
│   │   └── cloudApiRoutes.ts  # Cloud API routes (421 LOC)
│   ├── httpUtils.ts           # HTTP utilities
│   ├── fileOps.ts             # File operations
│   └── deployUtils.ts         # Deploy utilities
│
├── message/                   # Message formatting
│   └── slack.ts               # Slack message formatting
│
├── slack/                     # Slack integration
│   └── oauth.ts               # Slack OAuth (225 LOC)
│
├── chatgpt/                   # ChatGPT OAuth (2 files)
│   ├── oauth.ts               # OAuth flow (394 LOC)
│   └── store.ts               # Token storage
│
└── migrations/                # Database migrations (26 files)
    ├── 0001_init.ts
    ├── 0002_pending_messages.ts
    ├── ...                    # (see full list in repo)
    └── 0025_notion_mcp.ts
```

### Tests (`tests/`)

```
tests/
├── cloud-config.test.ts
├── cloud-proxy.test.ts
├── cloud-modal-provider.test.ts
├── cloud-modal-logs.test.ts
│
├── streamer/
│   ├── ToolCallManager.test.ts
│   ├── PlanUpdateHandler.test.ts
│   └── eventMappers/
│       ├── helpers.test.ts
│       ├── codexMapper.test.ts
│       └── claudeMapper.test.ts
│
└── session/
    ├── types.test.ts
    ├── SessionStateMachine.test.ts
    ├── ProcessLifecycleManager.test.ts
    └── EnvironmentBuilder.test.ts
```

## Data Flow Diagrams

### Local Agent Run Flow

```
┌────────┐    message     ┌──────────────┐
│  User  │ ──────────────▶│   Telegram   │
└────────┘                │    /Slack    │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │  service.ts  │
                          │  (webhook)   │
                          └──────┬───────┘
                                 │
                                 ▼
                          ┌──────────────┐
                          │ controller2  │
                          │ handleChat() │
                          └──────┬───────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
       ┌────────────┐    ┌────────────┐     ┌────────────┐
       │ New Session│    │Resume Sess │     │  Kill Sess │
       └─────┬──────┘    └─────┬──────┘     └────────────┘
             │                 │
             └────────┬────────┘
                      │
                      ▼
              ┌──────────────┐     env vars
              │SessionManager│ ◄────────────┐
              │startNew/     │              │
              │resumeSession │     ┌────────┴────────┐
              └──────┬───────┘     │EnvironmentBuilder│
                     │             │ - Language       │
                     │             │ - CloudProxy     │
                     │             │ - ChatGptProxy   │
                     │             └─────────────────┘
                     ▼
              ┌──────────────┐
              │ AgentAdapter │
              │  spawnExec() │
              └──────┬───────┘
                     │
                     ▼
         ┌─────────────────────┐
         │   CLI Process       │
         │ codex / claude-code │
         │                     │
         │  stdin ◄── prompt   │
         │  stdout ──▶ JSONL   │
         └──────────┬──────────┘
                    │
                    ▼ (write to file)
         ┌─────────────────────┐
         │    JSONL File       │
         │ ~/.tintin/sessions/ │
         └──────────┬──────────┘
                    │
                    │ (poll every N ms)
                    ▼
         ┌─────────────────────┐
         │   JsonlStreamer     │
         │     pollOnce()      │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │   EVENT_MAPPERS     │
         │ - codexMapper       │
         │ - claudeMapper      │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │  StreamFragment     │
         │ - text              │
         │ - tool_call         │
         │ - tool_output       │
         │ - plan_update       │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │  sendToSession()    │
         │  (rate-limited)     │
         └──────────┬──────────┘
                    │
                    ▼
         ┌─────────────────────┐
         │  Telegram / Slack   │
         │     / WebSocket     │
         └──────────┬──────────┘
                    │
                    ▼
              ┌──────────┐
              │   User   │
              └──────────┘
```

### Tool Call Pairing Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     JSONL Events                              │
└──────────────────────────────────────────────────────────────┘
         │
         │  {"type": "tool_use", "name": "Bash", ...}
         ▼
┌──────────────────┐
│ ToolCallManager  │
│   push(call)     │────────┐
└──────────────────┘        │
                            │ Queue: ["$ ls -la"]
         │                  │
         │  {"type": "tool_result", ...}
         ▼                  │
┌──────────────────┐        │
│ ToolCallManager  │◄───────┘
│   shift()        │
└────────┬─────────┘
         │
         │  Pair: (call, output)
         ▼
┌──────────────────┐
│formatToolPair    │
│   Message        │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  📎 $ ls -la                          │
│  ────────────────────────────────────│
│  total 48                             │
│  drwxr-xr-x  12 user  staff   384 ... │
│  -rw-r--r--   1 user  staff   156 ... │
└──────────────────────────────────────┘
```

### Session State Machine

```
                    ┌─────────┐
                    │  START  │
                    └────┬────┘
                         │
                         │ createSession()
                         ▼
                   ┌──────────┐
          ┌───────│ starting │───────┐
          │       └────┬─────┘       │
          │            │             │
     error│   success  │        kill │
          │            ▼             │
          │      ┌──────────┐        │
          │      │ running  │────────┤
          │      └────┬─────┘        │
          │           │              │
          │     ┌─────┴─────┐        │
          │     │           │        │
          │  exit=0    exit!=0       │
          │     │           │        │
          │     ▼           ▼        │
          │ ┌────────┐ ┌────────┐    │
          │ │finished│ │ error  │◄───┘
          │ └────────┘ └────┬───┘
          │                 │
          └─────────────────┴───────▶ ┌────────┐
                                      │ killed │
                                      └────────┘

Valid Transitions:
  - wizard   → starting
  - starting → running | error | killed
  - running  → finished | error | killed
  - finished → (terminal)
  - error    → (terminal)
  - killed   → (terminal)
```

### WebSocket Real-time Flow

```
┌────────────┐                              ┌────────────┐
│   Client   │                              │   Server   │
└─────┬──────┘                              └─────┬──────┘
      │                                           │
      │  ──────── WS Connect + Token ──────────▶  │
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │ Auth Check  │
      │                                    └──────┬──────┘
      │                                           │
      │  ◀─────── Connection Accepted ─────────  │
      │                                           │
      │  ──────── {"type": "chat",         ────▶  │
      │            "content": "Hello"}            │
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │  Handler    │
      │                                    │handleMessage│
      │                                    └──────┬──────┘
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │ Session     │
      │                                    │ Manager     │
      │                                    └──────┬──────┘
      │                                           │
      │  ◀─────── {"type": "fragment",     ─────  │
      │            "text": "I'll help..."}        │
      │                                           │
      │  ◀─────── {"type": "tool_call",    ─────  │
      │            "name": "Read"}                │
      │                                           │
      │  ◀─────── {"type": "tool_output",  ─────  │
      │            "content": "..."}              │
      │                                           │
      │  ◀─────── {"type": "done"}         ─────  │
      │                                           │
```

### WebSocket Cloud Run Flow

```
┌────────────┐                              ┌────────────┐
│   Client   │                              │   Server   │
└─────┬──────┘                              └─────┬──────┘
      │                                           │
      │  ──────── {"type": "auth"} ───────────▶  │
      │  ◀─────── {"type": "auth_ok"} ─────────  │
      │                                           │
      │  ──────── {"type": "cloud_run",    ────▶  │
      │            "repoIds": [...],              │
      │            "prompt": "Fix bug"}           │
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │CloudRunSvc  │
      │                                    │handleCloudRun│
      │                                    └──────┬──────┘
      │                                           │
      │                                    ┌──────┴──────┐
      │                                    │CloudManager │
      │                                    │  startRun   │
      │                                    └──────┬──────┘
      │                                           │
      │  ◀─────── {"type": "run_status"}   ─────  │
      │  ◀─────── {"type": "session_started"} ──  │
      │  ◀─────── {"type": "run_links"}    ─────  │
      │  ◀─────── {"type": "chunk", ...}   ─────  │
      │  ◀─────── {"type": "tool_call"}    ─────  │
      │  ◀─────── {"type": "tool_output"}  ─────  │
      │  ◀─────── {"type": "done"}         ─────  │
```

## Key Modules (`src/runtime/`)

### Core Modules

- **controller2.ts** (367 LOC): Central BotController - dispatches to platform-specific handlers, coordinates sessions and cloud runs
- **sessionManager.ts** (1084 LOC): Agent session lifecycle - spawns processes, monitors JSONL output, handles termination
- **streamer/JsonlStreamer.ts** (843 LOC): JSONL to chat fragments conversion with rate-limiting and chunking
- **service.ts** (563 LOC): HTTP server & bot initialization - OAuth callbacks, webhooks, UI endpoints
- **agents.ts / codex.ts / claudeCode.ts**: Agent adapters implementing `AgentAdapter` interface, spawning CLI processes

### Modular Controller (NEW)

- **controller/telegramHandler.ts** (1138 LOC): Telegram-specific command and interaction handling
- **controller/slackHandler.ts** (512 LOC): Slack-specific command and interaction handling
- **controller/cloudHandler.ts** (1536 LOC): Cloud command handling (cloud_help, cloud_status, etc.)
- **controller/interactionHandler.ts** (511 LOC): Shared interaction handling (buttons, selections)
- **controller/commands.ts** (497 LOC): Command parsing utilities
- **controller/sessions.ts** (265 LOC): Session management commands
- **controller/settings.ts** (468 LOC): Settings management commands

### Modular Streamer Components

- **streamer/ToolCallManager.ts**: FIFO queue for pairing tool calls with their outputs
- **streamer/PlanUpdateHandler.ts**: Parses plan updates and suppresses redundant outputs
- **streamer/PlaywrightScreenshotManager.ts** (456 LOC): Captures and sends browser screenshots via MCP
- **streamer/eventMappers/**: Converts agent-specific JSONL to unified StreamFragment format
  - **helpers.ts** (428 LOC): Shared formatting utilities
  - **codexMapper.ts** (275 LOC): Codex JSONL → StreamFragment
  - **claudeMapper.ts**: Claude JSONL → StreamFragment
  - **messageDispatcher.ts** (294 LOC): event_msg handling

### Modular Session Components

- **session/SessionStateMachine.ts**: Validates session state transitions (wizard→starting→running→finished/error/killed)
- **session/ProcessLifecycleManager.ts**: Manages agent process registration, timeouts, and termination
- **session/ChatGptProxyManager.ts** (350 LOC): Handles ChatGPT OAuth proxy process lifecycle
- **session/EnvironmentBuilder.ts**: Fluent builder for constructing agent environment variables

### Cloud Execution

- **cloud/manager.ts** (4533 LOC): Cloud run orchestration - workspace creation, file uploads, execution, snapshots
- **cloud/modalProvider.ts** (395 LOC): Modal sandbox provider implementing `CloudProvider` interface
- **cloud/localProvider.ts** (4932 LOC): Local provider for testing (implements `CloudProvider`)
- **cloud/store.ts** (1390 LOC): Cloud data access layer
- **cloud/githubApp.ts** (307 LOC): GitHub App integration
- **cloud/githubWebhook.ts** (563 LOC): GitHub webhook processing
- **cloud/disconnectCleanup.ts** (299 LOC): Shared GitHub App/OAuth disconnect cleanup
- **cloud/notion/** (NEW): Notion MCP OAuth integration (discovery, oauth, registration, token)
- **cloud/proxy.ts** (284 LOC): Cloud Proxy token authentication - allows CLI agents to access cloud API endpoints securely

### WebSocket Communication

- **websocket/manager.ts** (412 LOC): Connection management
- **websocket/handler.ts** (306 LOC): Message routing & authentication
- **websocket/types.ts** (407 LOC): Protocol definitions
- **websocket/services/cloud.ts** (714 LOC): CloudRunService - handles `cloud_run` and `subscribe_run`
- **websocket/services/github.ts** (342 LOC): GitHubService - OAuth and repository listing
- **websocket/services/identity.ts**: IdentityResolver - maps WebSocket identities to database identities
- **websocket/services/linkBuilder.ts**: CloudLinkBuilder - URL construction
- **websocket/services/sandboxLifecycle.ts** (266 LOC): Sandbox lifecycle management

### MCP Integration (Model Context Protocol)

- **mcp/registry.ts**: MCP server registry and lifecycle management
- **mcp/factory.ts**: Provider factory for creating MCP instances
- **mcp/config.ts**: MCP configuration with provider types
- **mcp/providers/stdio.ts**: Stdio transport provider
- **mcp/providers/http.ts**: HTTP transport provider
- **mcp/providers/github.ts**: GitHub MCP provider
- **mcp/providers/playwright/index.ts** (408 LOC): Playwright MCP provider with screenshot capture
- **cloud/notion/** (NEW): Notion MCP OAuth integration

### Platform Adapters

- **platform/telegram.ts** (999 LOC): Telegram client implementation
- **platform/slack.ts** (804 LOC): Slack client implementation
- **platform/base.ts**: Platform interface definition
- **platform/basePlatform.ts**: Base platform client with shared functionality

### HTTP Service Layer

- **service/httpServer.ts** (560 LOC): HTTP server implementation
- **service/sessionMessenger.ts** (724 LOC): Session messaging with rate limiting
- **service/commitProposals.ts** (367 LOC): Commit proposal handling
- **service/http/agentRoutes.ts** (888 LOC): Agent-related HTTP routes
- **service/http/cloudApiRoutes.ts** (421 LOC): Cloud API routes

### OAuth & Integration

- **chatgpt/oauth.ts** (394 LOC): ChatGPT OAuth flow handling
- **chatgpt/store.ts**: ChatGPT token storage
- **slack/oauth.ts** (225 LOC): Slack OAuth flow handling

## Code Conventions

- ESM-only (`"type": "module"`)
- Node.js 20-25
- Strict TypeScript mode
- Use `import type` for type-only imports
- Dependency injection pattern (services passed to constructors)
- Use injected `logger` (not console.log) with debug/info/warn/error levels
- Async/await with `RateLimiter` and `TaskQueue` utilities in `util.ts`
- Single Responsibility Principle - each module has one focused purpose
- Fluent builder pattern for complex object construction (EnvironmentBuilder)
- State machine pattern for lifecycle management (SessionStateMachine)

## Architectural Patterns

### Strategy Pattern
- **AgentAdapter**: Pluggable agent implementations (Codex, Claude Code)
- **CloudProvider**: Pluggable cloud providers (Modal, Local)
- **IMcpProvider**: Pluggable MCP providers (stdio, http, playwright, github, notion)
- **IMessagingPlatform**: Pluggable platforms (Telegram, Slack, WebSocket)

### State Machine Pattern
- **SessionStateMachine**: Valid session state transitions with validation
  - Valid transitions: wizard → starting → running → finished/error/killed
  - All states except terminal states have explicit valid transitions

### Builder Pattern
- **EnvironmentBuilder**: Fluent builder for constructing agent environment variables
  - `withLanguage()`, `withCloudProxy()`, `withChatGptProxy()`, `withMcpServers()`

### Factory Pattern
- **mcp/factory.ts**: Creates MCP provider instances based on configuration
- **platform/adapters.ts**: Creates platform client instances

### Registry Pattern
- **mcp/registry.ts**: Central registry for MCP server lifecycle management
- **streamer/eventMappers/index.ts**: Event mapper registry for agent types

### Dependency Injection
- All services receive dependencies via constructor
- Enables testing with mock implementations
- Examples: `SessionManager` receives `db`, `config`, `logger`, `mcpRegistry`

### Modular Architecture
- **controller/**: Platform-specific handlers extracted from monolithic controller
- **session/**: Session management components with clear responsibilities
- **streamer/**: Streaming components separated by concern
- **websocket/services/**: WebSocket message handlers by domain

### Observer Pattern
- **JsonlStreamer**: Polls JSONL file and emits fragments via callback
- **WebSocket services**: Send real-time updates to connected clients

## Configuration

All configuration is in `config.toml` (see `config.example.toml`). Key sections:

| Section | Description |
|---------|-------------|
| `[bot]` | Host, port, data directory, log level |
| `[db]` | Database URL (SQLite default, Postgres/MySQL supported) |
| `[codex]` / `[claude_code]` | Agent binary paths and timeouts |
| `[[projects]]` | Registered project paths for agents |
| `[telegram]` / `[slack]` | Platform credentials and webhooks |
| `[cloud]` | Provider (local/modal), Modal settings, proxy, OAuth |
| `[mcp]` | MCP providers configuration |
| `[chatgpt]` | ChatGPT OAuth configuration |
| `[github]` | GitHub App and OAuth configuration |
| `[notion]` | Notion MCP OAuth configuration |

### MCP Configuration

The `[mcp]` section supports multiple provider types:

```toml
[mcp]
# Playwright MCP for browser automation
[[mcp.providers]]
type = "playwright"

# Stdio-based MCP servers
[[mcp.providers]]
type = "stdio"
command = "node"
args = ["path/to/server.js"]

# HTTP-based MCP servers
[[mcp.providers]]
type = "http"
url = "https://api.example.com/mcp"

# GitHub MCP
[[mcp.providers]]
type = "github"

# Notion MCP (requires OAuth)
[[mcp.providers]]
type = "notion"
```

Environment variables can be referenced as `env:VAR_NAME` in config values.

## Internationalization

Tintin supports multi-language functionality for agent interactions:

### Supported Languages
- **en** (English)
- **zh** (Chinese)

### Language Configuration
Language can be configured at multiple levels:
1. **User preference**: Stored in `user_preferences` table
2. **Identity preference**: Stored in `identities` table
3. **Session level**: Set via `EnvironmentBuilder.withLanguage()`

### Language Flow
```
User Message → Identity (language) → SessionManager
                ↓
        EnvironmentBuilder.withLanguage(language)
                ↓
        Agent Process (LANG environment variable)
                ↓
        Agent responds in configured language
```

### Message Verbosity
The `MessageVerbosity` enum controls output detail:
- `minimal`: Only essential outputs
- `normal`: Standard output (default)
- `verbose`: Detailed output including debug info

### Branch Naming Rules
Language-aware branch naming can be configured per-identity:
```typescript
interface BranchNameRule {
  prefix?: string;    // e.g., "feat/", "fix/"
  separator?: string; // e.g., "-", "_"
  language?: string;  // For language-specific branches
}
```

## Database

Uses Kysely ORM with support for SQLite (default), PostgreSQL, and MySQL. Migrations in `src/runtime/migrations/`. Run `npm run migrate` after schema changes.

Key tables:
- `sessions` - Agent session records with status, language, timestamps, exit codes
- `session_offsets` - JSONL file read positions for streaming
- `identities` - User identities across platforms with preferences (language, verbosity, branch rules)
- `user_preferences` - Per-user language preferences
- `connections` - OAuth connections (GitHub, GitLab, Notion)
- `repos` - Connected repositories
- `cloud_runs` - Cloud execution runs with prompts and metadata
- `cloud_run_repos` - Run-repo relationships
- `cloud_snapshots` - Workspace snapshots
- `cloud_workspaces` - Cloud workspace metadata
- `deploy_registry` - Deployment registry
- `slack_installations` - Slack app installations
- `github_mcp_tokens` - GitHub MCP tokens
- `audit_events` - Audit trail for security events

### Recent Migrations

| Migration | Description |
|-----------|-------------|
| 0025_notion_mcp.ts | Notion MCP integration |
| 0024_github_mcp_tokens.ts | GitHub MCP token storage |
| 0023_slack_installations.ts | Slack app installation tracking |
| 0022_deploy_registry.ts | Deployment registry |
| 0021_session_language.ts | Session language support |
| 0020_user_preferences.ts | User preferences (language) |
| 0019_chatgpt_oauth.ts | ChatGPT OAuth token storage |
| 0018_github_disconnect.ts | GitHub disconnect tracking |

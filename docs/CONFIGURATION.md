# Tintin - Configuration Guide

Complete guide to configuring Tintin via `config.toml`.

## Quick Start

1. Copy `config.example.toml` to `config.toml`
2. Fill in required values (marked with `TODO`)
3. Run `npm run migrate` to initialize database

## Configuration Sections

### `[bot]` - Basic Settings

```toml
[bot]
host = "0.0.0.0"           # Server bind address
port = 3000                # Server port
data_dir = "~/.tintin"     # Data directory path
log_level = "info"         # debug | info | warn | error
```

### `[db]` - Database Configuration

```toml
[db]
url = "sqlite:~/.tintin/tintin.db"     # SQLite (default)
# url = "postgres://user:pass@host/db"  # PostgreSQL
# url = "mysql://user:pass@host/db"     # MySQL
pool_size = 10                          # Connection pool size
```

**Supported Databases:**
- SQLite (default) - Single file, no setup
- PostgreSQL - Production recommended
- MySQL - Alternative production option

### `[codex]` - Codex Agent Configuration

```toml
[codex]
bin = "codex"              # Path to codex binary
timeout = 300000           # Session timeout (ms)
max_retries = 3            # Max restart attempts
```

### `[claude_code]` - Claude Code Agent Configuration

```toml
[claude_code]
bin = "claude"             # Path to claude binary
timeout = 300000           # Session timeout (ms)
max_retries = 3            # Max restart attempts
```

### `[[projects]]` - Registered Projects

```toml
[[projects]]
name = "my-app"
path = "/path/to/repo"

[[projects]]
name = "backend"
path = "/path/to/backend"
```

**Agent will use these paths for:**
- Code context
- Git operations
- File operations

### `[telegram]` - Telegram Bot Configuration

```toml
[telegram]
enabled = true
token = "env:TELEGRAM_BOT_TOKEN"     # Bot token from BotFather
webhook_path = "/telegram/webhook"
```

**Setup:**
1. Create bot via @BotFather
2. Get token
3. Set as env var or put directly in config

### `[slack]` - Slack App Configuration

```toml
[slack]
enabled = true
signing_secret = "env:SLACK_SIGNING_SECRET"
bot_token = "env:SLACK_BOT_TOKEN"
webhook_path = "/slack/events"
```

**Setup:**
1. Create Slack App
2. Enable Bot Token
3. Get Signing Secret
4. Install to workspace

### `[cloud]` - Cloud Execution Settings

```toml
[cloud]
provider = "modal"         # modal | local

[cloud.modal]
token_id = "env:MODAL_TOKEN_ID"
token_secret = "env:MODAL_TOKEN_SECRET"
timeout = 600000          # Run timeout (ms)

[cloud.proxy]
enabled = true
url = "https://api.tintin.sh/proxy"

[cloud.oauth]
github_client_id = "env:GITHUB_CLIENT_ID"
github_client_secret = "env:GITHUB_CLIENT_SECRET"
slack_client_id = "env:SLACK_CLIENT_ID"
slack_client_secret = "env:SLACK_CLIENT_SECRET"
```

### `[mcp]` - Model Context Protocol

```toml
[mcp]
# Playwright MCP for browser automation
[[mcp.providers]]
type = "playwright"
headless = true

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

**Provider Types:**
| Type | Description | Example |
|------|-------------|---------|
| `playwright` | Browser automation | Web scraping, screenshots |
| `stdio` | Stdio transport | Custom MCP servers |
| `http` | HTTP transport | Remote MCP servers |
| `github` | GitHub integration | Repo operations, PRs |
| `notion` | Notion integration | Database, pages |

### `[chatgpt]` - ChatGPT OAuth

```toml
[chatgpt]
enabled = false
client_id = "env:CHATGPT_CLIENT_ID"
client_secret = "env:CHATGPT_CLIENT_SECRET"
redirect_uri = "http://localhost:3000/chatgpt/callback"
```

### `[github]` - GitHub Integration

```toml
[github]
# GitHub App (for webhooks)
app_id = "env:GITHUB_APP_ID"
private_key = "env:GITHUB_PRIVATE_KEY"
webhook_secret = "env:GITHUB_WEBHOOK_SECRET"

# OAuth (for cloud runs)
oauth_client_id = "env:GITHUB_OAUTH_CLIENT_ID"
oauth_client_secret = "env:GITHUB_OAUTH_CLIENT_SECRET"
```

### `[notion]` - Notion Integration

```toml
[notion]
oauth_client_id = "env:NOTION_CLIENT_ID"
oauth_client_secret = "env:NOTION_CLIENT_SECRET"
redirect_uri = "http://localhost:3000/notion/callback"
```

## Environment Variables

Reference env vars in config using `env:VAR_NAME`:

```toml
[telegram]
token = "env:TELEGRAM_BOT_TOKEN"    # Reads from process.env.TELEGRAM_BOT_TOKEN
```

**Benefits:**
- Security (don't commit secrets)
- Flexibility (different values per environment)
- Easy deployment (use `.env` files)

## Default .env Variables

Create a `.env` file in project root:

```bash
# Bot Tokens
TELEGRAM_BOT_TOKEN=your_token_here
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Cloud
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...

# OAuth
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...

# Database (optional, overrides config)
DATABASE_URL=sqlite:~/.tintin/tintin.db
```

## File Structure Reference

```
~/.tintin/
├── config.toml              # Main config
├── tintin.db                # SQLite database
├── sessions/                # Session JSONL files
│   └── {session_id}.jsonl
└── logs/                    # Application logs
    └── tintin.log
```

## Configuration Validation

Tintin validates config on startup:

```bash
# Check config syntax
npm run typecheck

# Test database connection
npm run migrate
```

**Common Errors:**
- `Invalid TOML`: Syntax error in config
- `Missing required field`: Required value not set
- `Database connection failed`: Invalid db.url

## Hot Reload

Configuration is loaded on startup. To reload:

```bash
# Restart the daemon
npm run restart

# Or manually
node dist/tintin.js stop
node dist/tintin.js start
```

## Example Configurations

### Development Setup

```toml
[bot]
host = "localhost"
port = 3000
log_level = "debug"

[db]
url = "sqlite:~/.tintin/tintin.dev.db"

[cloud]
provider = "local"    # Use local provider for testing
```

### Production Setup

```toml
[bot]
host = "0.0.0.0"
port = 8080
log_level = "info"

[db]
url = "postgres://user:pass@prod-db/tintin"
pool_size = 20

[cloud]
provider = "modal"
```

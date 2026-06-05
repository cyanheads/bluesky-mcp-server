<div align="center">
  <h1>@cyanheads/bluesky-mcp-server</h1>
  <p><b>Search posts, profiles, feeds, threads, and trending topics on Bluesky via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/bluesky-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/bluesky-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/bluesky-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/bluesky-mcp-server/releases/latest/download/bluesky-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=bluesky-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYmx1ZXNreS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22bluesky-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fbluesky-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Seven tools for read-only access to the public Bluesky/AT Protocol AppView — no authentication required:

| Tool | Description |
|:-----|:------------|
| `bsky_search_posts` | Full-text search across public Bluesky posts, with author, language, tag, domain, date, and sort filters |
| `bsky_get_profile` | Fetch a Bluesky actor's public profile by handle or DID — the handle↔DID resolver |
| `bsky_get_author_feed` | A user's recent posts ordered newest-first, filterable by post type |
| `bsky_get_post_thread` | Fetch the full conversation for a post by AT-URI — parent chain upward and reply tree downward |
| `bsky_search_actors` | Find Bluesky accounts by name or handle fragment |
| `bsky_get_follows` | Paginated social graph edges — who a user follows or who follows them |
| `bsky_get_trending` | Real-time trending topics on Bluesky with post count, category, and status |

### `bsky_search_posts`

Full-text search across public Bluesky posts.

- Filters: author handle, language (BCP-47), hashtag, domain, date range (`since`/`until`), and sort order (`top` or `latest`)
- Returns posts with text, author, engagement counts (likes/reposts/replies/quotes), embeds, AT-URIs, and timestamps
- `hitsTotal` when available — total matching posts, not just the current page
- Pagination via opaque cursor; up to 100 results per call
- Embeds normalized into a flat union: `images`, `external` (link cards), `record` (quoted posts), `video`, `unknown`
- Moderation labels surfaced as-is — not filtered

---

### `bsky_get_profile`

Fetch a Bluesky actor's public profile by handle or DID.

- Returns displayName, handle, DID, description, follower/following/post counts, avatar URL, moderation labels, and pinned post AT-URI
- The resolution step for handle↔DID — use before tools that require a DID or AT-URI when you only have a handle

---

### `bsky_get_author_feed`

A user's recent posts ordered newest-first.

- Filter by post type: `posts_with_replies`, `posts_no_replies`, `posts_with_media`, or `posts_and_author_threads`
- Returns posts with full text, engagement counts, embeds, and AT-URIs for thread drilling
- Pagination via cursor

---

### `bsky_get_post_thread`

Fetch the full conversation for a post by AT-URI.

- Returns the root post, parent chain (upward), and nested reply tree (downward)
- Configurable `depth` (reply tree depth, default 6) and `parent_height` (parent chain height, default 80)
- Truncated subtrees surface `truncated: true`; deleted posts surface as `not_found`
- AT-URIs come from `bsky_search_posts` or `bsky_get_author_feed`

---

### `bsky_get_follows`

Fetch social graph edges for an account.

- `direction`: `followers` (who follows the actor) or `following` (who the actor follows)
- Returns paginated profiles with handle, DID, displayName, description, and follower count
- Includes the subject's profile summary at the top level

---

### `bsky_get_trending`

Fetch real-time trending topics on Bluesky.

- Returns topics with display name, post count, category (politics, sports, pop-culture, etc.), status (hot/rising), and start time
- No cursor — returns the current snapshot up to `limit`
- Uses `app.bsky.unspecced.getTrends` — Bluesky may change this endpoint without notice

## Resource

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `bsky://profile/{actor}` | A Bluesky actor's public profile, addressable by handle or DID |

All resource data is also reachable via tools. Use `bsky_get_profile` for programmatic access or `bsky://profile/{actor}` to inject profile context directly.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Bluesky-specific:

- No authentication required — all seven tools operate against `api.bsky.app` without credentials
- Single `BlueskyService` wrapping the AT Protocol public AppView with retry (3 attempts, 500ms base), 15s timeout, and a versioned `User-Agent`
- Embed normalization — raw nested AT Protocol embed objects flattened to a clean `type`-discriminated union
- Moderation labels surfaced verbatim — the agent and its human decide what to do
- AT Protocol identifier types (handle, DID, AT-URI) explained at first encounter in every tool description

Agent-friendly output:

- AT-URIs on every post and resource — chain `bsky_search_posts` → `bsky_get_post_thread` without extra steps
- Discriminated embed union (`type: "images" | "external" | "record" | "video" | "unknown"`) — branch on data, not `$type` strings
- `hitsTotal` on search results — communicate result scale to users without extra round trips
- Truncation signals (`truncated: true`) on thread nodes — agents know where the tree ends and why

## Getting started

Add the following to your MCP client configuration file. No API key required.

```json
{
  "mcpServers": {
    "bluesky-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/bluesky-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "bluesky-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/bluesky-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "bluesky-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/bluesky-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account required — all tools call `api.bsky.app` without credentials.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/bluesky-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd bluesky-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to override any framework defaults
```

## Configuration

This server requires no API keys. All framework configuration is optional.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t bluesky-mcp-server .
docker run --rm -p 3010:3010 bluesky-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/bluesky-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools, resource, and inits service. |
| `src/services/bluesky` | AT Protocol AppView HTTP client with retry, timeout, and `User-Agent`. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — seven read-only Bluesky tools. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — `bsky://profile/{actor}`. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

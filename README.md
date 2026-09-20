<div align="center">
  <h1>@cyanheads/bluesky-mcp-server</h1>
  <p><b>Search posts, profiles, feeds, threads, and trending topics on Bluesky via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/bluesky-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/bluesky-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/bluesky-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/bluesky-mcp-server/releases/latest/download/bluesky-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=bluesky-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvYmx1ZXNreS1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22bluesky-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fbluesky-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://bluesky.caseyjhand.com/mcp](https://bluesky.caseyjhand.com/mcp)

</div>

---

## Overview

Public Bluesky data over the AT Protocol AppView — no authentication required. Search posts, resolve profiles, walk feeds and threads, and track trending topics from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `bsky_search_posts` | Full-text search across public Bluesky posts, with author, language, tag, date, and sort filters |
| `bsky_get_profile` | Fetch a Bluesky actor's public profile by handle or DID — the handle↔DID resolver |
| `bsky_get_author_feed` | A user's recent posts ordered newest-first, filterable by post type |
| `bsky_get_post_thread` | Fetch the conversation for a post by AT-URI — parent chain upward and reply tree downward, with what Bluesky counted but did not return |
| `bsky_search_actors` | Find Bluesky accounts by name or handle fragment |
| `bsky_get_follows` | Paginated social graph edges — who a user follows or who follows them |
| `bsky_get_trending` | Real-time trending topics on Bluesky with post count, category, status, and the accounts driving each topic |

### Resources

| Resource | Description |
|:---|:---|
| `bsky://profile/{actor}` | A Bluesky actor's public profile, addressable by handle or DID |

All resource data is also reachable via tools. Use `bsky_get_profile` for programmatic access or `bsky://profile/{actor}` to inject profile context directly.

## Capability reference

### `bsky_search_posts` <sub>tool</sub>

- Filters: author handle or DID, BCP-47 language, hashtag, `since`/`until` date range, and `top`/`latest` sort; up to 100 results per call via opaque cursor pagination
- Identifier, language, and date inputs are pattern-validated locally before the upstream call; a well-formed but unindexed language tag (e.g. `"qqq"`) returns unfiltered results rather than an error
- When Bluesky rejects a parameter, its own explanation is surfaced via the `upstream_rejected_filter` error reason instead of a bare status code
- `hitsTotal` is capped at 10,000 — a value of exactly 10,000 means "at least that many," not an exact count; `truncated`/`shown`/`cap` disclose when more posts matched than were returned (a cursor alone doesn't imply truncation — Bluesky returns one on every non-empty response)
- Embeds normalize to a `type`-discriminated union (`images`, `external`, `record`, `video`, `unknown`); a quoted post carries its own attachments up to 3 nesting levels, with `omittedEmbeds` counting what went deeper and `recordKind` naming a quote that's deleted, blocked, detached, or not a post
- Moderation labels are surfaced as-is, unfiltered

---

### `bsky_get_profile` <sub>tool</sub>

- Accepts a handle or DID; returns displayName, handle, DID, bio, pronouns, website, follower/following/post counts, avatar, moderation labels, and pinned post AT-URI
- `website` is the one link carried in its own field rather than inside the bio; both it and `pronouns` are absent when the account set neither
- The bio renders as a markdown blockquote in `content[]`, since it's account-authored text that can carry its own markdown structure
- `actor_not_found` when the handle doesn't resolve — resolve the handle with `bsky_search_actors` first
- The primary handle↔DID resolver — use before tools that require a DID or AT-URI when only a handle is known

---

### `bsky_get_author_feed` <sub>tool</sub>

- `filter`: `posts_with_replies`, `posts_no_replies` (default, excludes replies), `posts_with_media`, or `posts_and_author_threads` — none exclude reposts, since the AppView has no repost filter
- Reposts carry `repostedBy` and `repostedAt`; `author` always names who actually wrote the post
- `limit` counts reposts too, so a heavily-reposting account can return far fewer of its own posts than the limit suggests; `originalPosts`/`reposts` report the actual split whenever a repost is present
- Up to 100 posts per call, paginated via cursor
- `actor_not_found` when the handle or DID doesn't resolve

---

### `bsky_get_post_thread` <sub>tool</sub>

- `depth` (reply levels, default 6, max 10 — Bluesky's own ceiling, however deep the request) and `parent_height` (parent chain height, default 80, max 100)
- A node returning fewer replies than its own `replyCount` carries `truncated: true`, `unreturnedReplies` (an upper bound, not an exact shortfall), and `truncationReason` (`"depth"` — fetch that node's AT-URI to continue, or `"unavailable"` — no request closes the gap)
- When the parent chain stops at `parent_height` short of the conversation root, the topmost node carries `parentChainTruncated: true` — recoverable by fetching that node's AT-URI as its own thread
- Surfaces the author's reply gate when set (who may reply) and the AT-URIs of any replies the author hid; deleted posts return `notFound: true` and blocked posts `blocked: true`
- Reply depth renders on the author heading (`### ↳2 Name`) rather than by indentation, so a deeply nested reply never crosses into a markdown code block
- `invalid_at_uri` and `post_not_found` errors when the AT-URI doesn't resolve; AT-URIs come from `bsky_search_posts` or `bsky_get_author_feed`

---

### `bsky_search_actors` <sub>tool</sub>

- Returns ranked profiles with handle, DID, displayName, bio, pronouns when set, and follower count — not `website`, which only `bsky_get_profile` returns
- Bio renders as a markdown blockquote in `content[]`, since it's account-authored text
- Up to 100 results per call, paginated via cursor — cursor pagination is unreliable for unauthenticated search on the public AppView and may return a 403
- Use before `bsky_get_profile` or `bsky_get_author_feed` when you have a name but not a confirmed handle

---

### `bsky_get_follows` <sub>tool</sub>

- `direction`: `followers` (who follows the actor) or `following` (who the actor follows)
- Returns paginated profiles (handle, DID, displayName, bio, pronouns when set, follower count) plus the subject's own profile summary
- No `website` field on this view — resolve with `bsky_get_profile` when it matters
- Up to 100 per page, paginated via cursor
- `actor_not_found` when the handle or DID doesn't resolve

---

### `bsky_get_trending` <sub>tool</sub>

- Returns topics with display name, post count, category, status (`hot`/`rising`), start time, and up to 5 representative accounts driving each topic
- No cursor — returns the current snapshot up to `limit` (default 10, max 25)
- Uses `app.bsky.unspecced.getTrends`, an unstable endpoint Bluesky may change without notice

---

### `bsky://profile/{actor}` <sub>resource</sub>

- Returns the same fields as `bsky_get_profile` in injectable-context form — displayName, handle, DID, bio, pronouns, website, follower/following/post counts, avatar, moderation labels, pinned post AT-URI
- Addressable by handle or DID via `{actor}`
- `actor_not_found` when the handle doesn't resolve

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Bluesky-specific:

- No authentication required — all seven tools operate against `api.bsky.app` without credentials
- Single `BlueskyService` wrapping the AT Protocol public AppView, with a 15s per-request timeout, retry (up to 3 retries, 500ms base delay), and a versioned `User-Agent`
- Embed normalization — raw nested AT Protocol embed objects flattened into a clean `type`-discriminated union
- Moderation labels surfaced verbatim and unfiltered
- AT Protocol identifier types (handle, DID, AT-URI) explained at first encounter in each tool's description

Agent-friendly output:

- AT-URIs on every post — chain `bsky_search_posts` → `bsky_get_post_thread` without extra steps
- Discriminated embed union — `type: "images" | "external" | "record" | "video" | "unknown"` lets callers branch on data instead of parsing `$type` strings; an unmapped lexicon type arrives as `unknown` with its raw `$type` rather than vanishing
- Third-party text rendered as markdown blockquotes — post bodies, bios, alt text, and link-card text render as `>`-prefixed blockquotes in `content[]`, so a post's own heading or code fence never merges with the server's structure; values that render inline (display names, pronouns, topic names) have line breaks folded to spaces for the same reason
- Bounded truncation disclosure — thread and pagination shortfalls (`truncated`, `unreturnedReplies`, `parentChainTruncated`, `hitsTotal` at its 10,000 cap) are reported as bounds rather than measurements

## Getting started

### Public Hosted Instance

Connect directly — no installation required:

```json
{
  "mcpServers": {
    "bluesky-mcp-server": {
      "type": "streamable-http",
      "url": "https://bluesky.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto`. Unset or empty, the server resolves to `stateless` from its own `createApp({ sessionMode })` declaration; an explicit value still overrides it. | `stateless` |
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

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

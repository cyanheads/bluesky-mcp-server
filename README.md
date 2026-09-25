<div align="center">
  <h1>@cyanheads/bluesky-mcp-server</h1>
  <p><b>Search posts, profiles, feeds, threads, and trending topics on Bluesky via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/bluesky-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/bluesky-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/bluesky-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Bluesky data over the AT Protocol AppView. Resolve profiles, track trending topics and read the feeds behind them, walk custom feeds, author feeds, threads, and the quote posts on a post — all without an account — and add full-text post search with an optional app password. Shared bsky.app links and `@handle`s work wherever the matching account, post, or feed is asked for. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `bsky_search_posts` | Full-text search across public Bluesky posts, with author, mention, language, tag, domain, URL, date, and sort filters — offered only when an app password is configured |
| `bsky_get_profile` | Fetch a Bluesky actor's public profile by handle or DID — the handle↔DID resolver |
| `bsky_get_feed` | Read a feed generator's posts — a trend's feed, Discover, or any custom feed — by AT-URI or bsky.app URL |
| `bsky_get_author_feed` | A user's recent posts ordered newest-first, filterable by post type |
| `bsky_get_post_thread` | Fetch the conversation for a post by AT-URI or bsky.app URL — parent chain upward and reply tree downward, with what Bluesky counted but did not return |
| `bsky_get_post_quotes` | Read the quote posts behind a post's `quoteCount`, newest first — where much of the reaction to a post lives |
| `bsky_search_actors` | Find Bluesky accounts by name or handle fragment |
| `bsky_get_follows` | Paginated social graph edges — who a user follows or who follows them |
| `bsky_get_trending` | Real-time trending topics on Bluesky with a story summary, post count, category, status, the accounts driving each topic, and the feed that collects its posts |

### Resources

| Resource | Description |
|:---|:---|
| `bsky://profile/{actor}` | A Bluesky actor's public profile, addressable by handle or DID |

All resource data is also reachable via tools. Use `bsky_get_profile` for programmatic access or `bsky://profile/{actor}` to inject profile context directly.

## Capability reference

### `bsky_search_posts` <sub>tool</sub>

- Bluesky refuses post search without a signed-in account, so this tool is registered only when `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` are set — without them it is absent from `tools/list` (see [Post search](#post-search))
- Searches run as that account through its PDS; the first search logs in, the session is reused and refreshed, and a rejected login is not retried. Failures surface as `search_auth_failed` (the login or its renewal was rejected), `search_login_limited` (the account's daily login limit is used up — the error names when searching resumes), or `search_refused` (Bluesky refused the search)
- Filters: author and mentioned account (handle or DID, also as `@handle` or a bsky.app profile URL — `mentions` matches rich-text mentions only), two-letter language code, hashtag (with or without `#`), linked `domain` (bare hostname, leading `www.` dropped) or exact `url` (in text links or link cards), `since`/`until`, and `top`/`latest` sort; up to 100 results per call via opaque cursor pagination
- `since`/`until` compare against each post's sort time — the earlier of `createdAt` and `indexedAt` — to the whole second, inclusive; a date alone is 00:00:00 UTC, so `until: "2026-01-01"` covers all of 2025-12-31
- Identifier, language, domain, URL, and date inputs are pattern-validated locally before the upstream call. A three-letter language code (`"fil"`, `"eng"`) is rejected, since Bluesky search ignores one and returns unfiltered results; the code is sent lowercased, and later subtags are accepted but ignored upstream (`en-US` filters as `en`)
- When Bluesky rejects a parameter, its own explanation is surfaced via the `upstream_rejected_filter` error reason instead of a bare status code; a cursor it can't decode fails as `invalid_cursor`, after one request
- `hitsTotal` is Bluesky's estimate, never an exact count: below 10,000 it is an upper bound on what paging returns (Bluesky counts before dropping posts it won't return), and exactly 10,000 — the cap — means "at least that many"; `truncated`/`shown`/`cap` are keyed on the returned cursor, which Bluesky omits once nothing more matches
- A page that would pass the 48,000-byte response budget on either surface is searched again at the `limit` that fits and returned whole — `budgetCapped: true`, with `hitsTotal` and the cursor from that one response
- Embeds normalize to a `type`-discriminated union (`images`, `external`, `record`, `video`, `unknown`); a quoted post carries its own attachments up to 3 nesting levels, with `omittedEmbeds` counting what went deeper and `recordKind` naming a quote that's deleted, blocked, detached, or not a post
- Moderation labels are surfaced as-is, unfiltered

---

### `bsky_get_feed` <sub>tool</sub>

- Takes a feed generator AT-URI (`at://<handle-or-did>/app.bsky.feed.generator/<rkey>`) or its bsky.app page (`https://bsky.app/profile/<handle-or-did>/feed/<rkey>`, with any trailing `/`, `?…`, or `#…` ignored); a trend's `feedUri` works as-is, and Discover is `at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot`
- A handle owner costs one extra lookup (`resolveHandle`), a DID owner none; any other collection, such as a post AT-URI, is rejected before the upstream call
- A post the feed pinned to its top carries `pinned: true`; a repost carries `repostedBy`/`repostedAt`
- Up to 100 posts per call, paginated via cursor; truncation is disclosed on the cursor, since a feed can return fewer than `limit` with more behind it
- A page that would pass the 48,000-byte response budget is asked for again at the `limit` that fits and returned whole, marked `budgetCapped: true`; a ranked feed reranks on every request, so its posts and cursor still come from one response
- `feed_not_found` (no such feed or handle), `feed_unavailable` (the feed's generator did not answer — not retried, so a down feed fails fast), `feed_requires_login` (a personalized feed)
- Always unauthenticated, even when search credentials are set

---

### `bsky_get_profile` <sub>tool</sub>

- Accepts a handle or DID, also as `@handle` or the account's bsky.app page (`https://bsky.app/profile/<handle-or-did>`); returns displayName, handle, DID, bio, pronouns, website, follower/following/post counts, avatar, moderation labels, and pinned post AT-URI
- `website` is the one link carried in its own field rather than inside the bio; both it and `pronouns` are absent when the account set neither
- `verification` carries Bluesky's full verification state — `verifiedStatus` and `trustedVerifierStatus` (`valid`, `invalid`, or `none`, passed through verbatim) and every verification a trusted verifier issued, with its issuer, validity, date, and record AT-URI; absent when Bluesky sent none
- The bio renders as a markdown blockquote in `content[]`, since it's account-authored text that can carry its own markdown structure
- `actor_not_found` when the handle doesn't resolve — resolve the handle with `bsky_search_actors` first
- The primary handle↔DID resolver — use before tools that require a DID or AT-URI when only a handle is known

---

### `bsky_get_author_feed` <sub>tool</sub>

- Takes a handle or DID, also as `@handle` or the account's bsky.app page
- `filter`: `posts_with_replies`, `posts_no_replies` (default, excludes replies), and `posts_and_author_threads` include reposts; `posts_with_media` (the actor's own posts with images or video, no link cards) and `posts_with_video` return none
- `include_pins: true` adds the profile's pinned post, marked `pinned: true`, first on the first page — in addition to `limit`, and whether or not it matches `filter`
- Reposts carry `repostedBy` and `repostedAt`; `author` always names who actually wrote the post
- Under the filters that include reposts, `limit` counts them too, so a heavily-reposting account can return far fewer of its own posts than the limit suggests; `originalPosts`/`reposts` report the actual split whenever a repost is present
- Up to 100 posts per call, paginated via cursor; a page that would pass the 48,000-byte response budget is asked for again at the `limit` that fits (the pin not counted), marked `budgetCapped: true`, and its cursor resumes at the first post left out
- `actor_not_found` when the handle or DID doesn't resolve; `invalid_cursor`, after one request, when Bluesky can't decode the cursor passed (it answers those with HTTP 500, which is otherwise retried)

---

### `bsky_get_post_thread` <sub>tool</sub>

- Takes a post AT-URI or its bsky.app page (`https://bsky.app/profile/<handle-or-did>/post/<rkey>`, trailing `/`, `?…`, or `#…` ignored)
- Replies only — quote posts live under `bsky_get_post_quotes`
- `depth` (reply levels, default 6, max 10 — Bluesky's own ceiling, however deep the request) and `parent_height` (parent chain height, default 80, max 100)
- A node returning fewer replies than its own `replyCount` carries `truncated: true`, `unreturnedReplies` (an upper bound, not an exact shortfall), and `truncationReason` (`"depth"` — fetch that node's AT-URI to continue, or `"unavailable"` — no request closes the gap)
- When the parent chain stops at `parent_height` short of the conversation root, the topmost node carries `parentChainTruncated: true` — recoverable by fetching that node's AT-URI as its own thread
- A thread that would pass the 48,000-byte response budget keeps the target, then parents nearest-first, then replies level by level, and cuts between whole posts: `budgetCapped` and `budgetOmitted` (posts left out) in enrichment, `budgetOmittedReplyUris` on the target, `budgetOmittedReplies` on a kept reply, and `budgetOmittedParents` on the topmost parent kept — fetching those AT-URIs reads everything left out
- Surfaces the author's reply gate when set (who may reply) and the AT-URIs of any replies the author hid; deleted posts return `notFound: true` and blocked posts `blocked: true`
- Reply depth renders on the author heading (`### ↳2 Name`) rather than by indentation, so a deeply nested reply never crosses into a markdown code block
- `invalid_at_uri` and `post_not_found` errors when the AT-URI doesn't resolve; AT-URIs come from the `uri` field of any returned post
- A feed generator AT-URI (`app.bsky.feed.generator`) is rejected before any request as `uri_is_feed`, pointing to `bsky_get_feed`

---

### `bsky_get_post_quotes` <sub>tool</sub>

- Takes a post AT-URI or its bsky.app page; any other collection is rejected before the upstream call
- A DID-authority post costs one request; a handle costs one extra lookup (`resolveHandle`), since `getQuotes` answers a handle authority with an empty list
- Every result quotes the same post, so each result's embed keeps only that post's AT-URI and CID, its `recordKind` when it's unreadable, and any media the quoting post attached — the queried post's text and attachments aren't repeated on every item
- Up to 100 quotes per call, newest first, paginated via cursor; truncation is disclosed on the cursor, since pages often come back short of `limit` with more behind them
- A page that would pass the 48,000-byte response budget is asked for again at the `limit` that fits, marked `budgetCapped: true`, and its cursor resumes at the first quote left out
- `quoteCount` is an upper bound on what this returns — Bluesky's counter keeps quotes that have left the index
- `post_not_found` when the post doesn't exist or its handle doesn't resolve (an empty first page is checked with one `getPosts`); `invalid_cursor` after one request for a cursor Bluesky can't decode

---

### `bsky_search_actors` <sub>tool</sub>

- Returns ranked profiles with handle, DID, displayName, bio, and pronouns when set — no follower, following, or post counts and no `website`, which only `bsky_get_profile` returns
- Each account carries its two verification statuses (`verification.verifiedStatus`, `verification.trustedVerifierStatus`) when Bluesky sent them, which tells a verified account from a look-alike handle; who issued the verification is on `bsky_get_profile`
- Bio renders as a markdown blockquote in `content[]`, since it's account-authored text
- Up to 100 results per call, paginated via cursor; pages often hold fewer than `limit` and still continue, and the last page carries no cursor
- `invalid_cursor`, after one request, when Bluesky can't decode the cursor passed (it answers those with HTTP 400)
- Use before `bsky_get_profile` or `bsky_get_author_feed` when you have a name but not a confirmed handle

---

### `bsky_get_follows` <sub>tool</sub>

- `direction`: `followers` (who follows the actor) or `following` (who the actor follows)
- `sort`: `latest` (Bluesky's default — most recent follows first) or `top` (Bluesky's own ranking of prominent accounts, not a follower-count order); pass a cursor back with the same `sort`
- Takes a handle or DID, also as `@handle` or the account's bsky.app page
- Returns paginated profiles (handle, DID, displayName, bio, pronouns when set, verification statuses) plus the subject's own profile summary, which carries its statuses too
- No follower, following, or post counts and no `website` on this view, for the list or the subject — resolve with `bsky_get_profile` when they matter
- Up to 100 per page, paginated via cursor. A cursor can lead to an empty page when the remaining accounts no longer resolve, which the response reports as the end of the list
- `actor_not_found` when the handle or DID doesn't resolve

---

### `bsky_get_trending` <sub>tool</sub>

- Returns topics with display name, Bluesky's one-sentence story summary (`description`), post count, category, status (e.g. `hot`, `cooling`, `stale`), start time, and up to 5 representative accounts driving each topic
- Each trend is backed by a feed generator: `feedUri` is that feed's AT-URI, parsed from the trend's `link`, and `bsky_get_feed` reads its posts; `topic` is the feed's record key, not a search term
- No cursor — returns the current snapshot up to `limit` (default 10, max 25, Bluesky's own maximum); `truncated` means more topics are trending than `limit`, so it never appears at 25
- Uses `app.bsky.unspecced.getTrends`, an unstable endpoint Bluesky may change without notice

---

### `bsky://profile/{actor}` <sub>resource</sub>

- Returns the same fields as `bsky_get_profile` in injectable-context form — displayName, handle, DID, bio, pronouns, website, follower/following/post counts, avatar, moderation labels, pinned post AT-URI, full verification state
- Addressable by handle or DID via `{actor}`, with or without a leading `@` (`bsky://profile/@bsky.app`)
- `actor_not_found` when the handle doesn't resolve

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Bluesky-specific:

- Eight of nine tools read `api.bsky.app` without credentials; `bsky_search_posts` runs through an optional app-password session and is left out without one
- Shared links as input — `@handle` and a bsky.app profile URL wherever an account is asked for, a bsky.app post or feed URL wherever that post or feed is, each rewritten to the handle, DID, or AT-URI it names before the request
- Single `BlueskyService` wrapping the AT Protocol AppView, with a 15s per-request timeout, retry on transient upstream failures (up to 3 retries, 500ms base delay — never for a login, or for a failure already mapped to a tool error), and a versioned `User-Agent`
- No HTML in any error — a block page from Bluesky's edge is dropped from the error data, leaving the status
- Embed normalization — raw nested AT Protocol embed objects flattened into a clean `type`-discriminated union
- Moderation labels surfaced verbatim and unfiltered
- AT Protocol identifier types (handle, DID, AT-URI) explained at first encounter in each tool's description

Agent-friendly output:

- AT-URIs on every post — chain `bsky_get_trending` → `bsky_get_feed` → `bsky_get_post_thread` without extra steps
- Verification on every account an agent picks or cites — post authors on all five post tools, actor search, and the follow graph carry Bluesky's `verifiedStatus` / `trustedVerifierStatus` on the author's DID line; `bsky_get_profile` adds who issued each verification
- Discriminated embed union — `type: "images" | "external" | "record" | "video" | "unknown"` lets callers branch on data instead of parsing `$type` strings; an unmapped lexicon type arrives as `unknown` with its raw `$type` rather than vanishing
- Third-party text rendered as markdown blockquotes — post bodies, bios, alt text, and link-card text render as `>`-prefixed blockquotes in `content[]`, so a post's own heading or code fence never merges with the server's structure; values that render inline (display names, pronouns, topic names) have line breaks folded to spaces for the same reason. Inside both, the Markdown and raw HTML a CommonMark renderer would act on — emphasis, links, images, code, lists, headings, tags, entities — is escaped, so user text displays as written; URLs stay copyable and `structuredContent` carries every string unmodified. Each quote ends before the next line the server writes, so a rendering client never folds a post's counts or labels into it
- Bounded truncation disclosure — thread and pagination shortfalls (`truncated`, `unreturnedReplies`, `parentChainTruncated`, `hitsTotal` at its 10,000 cap) are reported as bounds rather than measurements
- A 48,000-byte response budget per surface on every post-returning tool, measured on the rendered output and cut only between whole posts — pages are re-requested at the `limit` that fits so their cursor still continues where they end, threads mark the posts they left out by AT-URI, and `budgetCapped` says when either happened; a response that fits is unchanged

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

Add the following to your MCP client configuration file. No API key required; add `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` to `env` to enable post search.

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
- No API key or account required for anything but post search. See [Post search](#post-search) to enable it.

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

This server requires no API keys. Everything below is optional.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `BLUESKY_IDENTIFIER` | Handle, DID, or email of the account post search runs as. Set together with `BLUESKY_APP_PASSWORD`, or neither. | — |
| `BLUESKY_APP_PASSWORD` | App password for that account. Without the pair, `bsky_search_posts` is not offered. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http` | `stdio` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateful`, `stateless`, or `auto`. Unset or empty, the server resolves to `stateless` from its own `createApp({ sessionMode })` declaration; an explicit value still overrides it. | `stateless` |
| `MCP_HTTP_PORT` | Port for HTTP server | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth` | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424) | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only) | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

### Post search

Bluesky refuses `app.bsky.feed.searchPosts` without a signed-in account, so `bsky_search_posts` is registered only when `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` are both set. Setting one without the other fails startup with a message naming the missing variable.

- **Use a dedicated account** with a standard (non-privileged) app password — create one under Settings → Privacy and security → App passwords. The server never needs DM access.
- **Search runs as that account for every caller.** The AppView leaves out posts from accounts in a block relationship with it, in either direction; it does not apply mutes. On a shared instance, anyone can block the account and drop their posts from its results.
- **Logins are scarce.** Bluesky limits `createSession` to about 10 per day per account, so the server logs in on the first search — never at startup — reuses the session, refreshes it when the access token expires, and logs in again only when the refresh is rejected. A rejected login is not retried until the process restarts. When Bluesky answers a login or refresh with 429, every search fails as `search_login_limited` without a request until the `ratelimit-reset` time it names (15 minutes when it names none), then logs in again.
- Credentials and tokens stay in memory; they never appear in logs, errors, or tool output, and no other tool sends them.

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
| `src/index.ts` | `createApp()` entry point — reads config, registers tools and resource, and inits the service. |
| `src/config` | Server config — the optional app-password pair that enables post search. |
| `src/services/bluesky` | AT Protocol HTTP client — public AppView reads, the app-password search session, retry, timeout, and `User-Agent`. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — nine read-only Bluesky tools. |
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

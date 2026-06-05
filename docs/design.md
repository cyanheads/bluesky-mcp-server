# Bluesky MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `bsky_search_posts` | Full-text search across public Bluesky posts. Filters by author, language, domain, hashtag, date range, and sort order. Returns posts with text, author, engagement counts (likes/reposts/replies), embeds, AT-URIs, timestamps, and `hitsTotal` when available (total matching posts, not just the current page — use for communicating result scale). The headline tool — real-time open social discourse on any topic. | `query` (required), `author_handle`, `language`, `tag`, `since`, `until`, `sort` (enum: `top`\|`latest`, default `latest`), `limit` (≤100), `cursor` | `readOnlyHint: true` |
| `bsky_get_profile` | Fetch a Bluesky actor's public profile by handle or DID. Returns displayName, handle, DID, description, follower/following/post counts, avatar URL, labels (moderation), and pinned post AT-URI. Resolves handle↔DID — use before tools that require a DID or AT-URI when you only have a handle. | `actor` (handle or DID, required) | `readOnlyHint: true` |
| `bsky_get_author_feed` | A user's recent posts ordered newest-first. Filter by post type to see only original posts, posts with media, or everything including replies. Returns posts with full text, engagement, embeds, and AT-URIs for thread drilling. | `actor` (handle or DID, required), `filter` (posts\_with\_replies\|posts\_no\_replies\|posts\_with\_media\|posts\_and\_author\_threads), `limit`, `cursor` | `readOnlyHint: true` |
| `bsky_get_post_thread` | Fetch the full conversation for a post by AT-URI — the parent chain upward and the reply tree downward. Useful for reading an entire discussion from any entry point. Returns root post, parent chain, and nested replies with per-post author and engagement data. | `uri` (AT-URI matching `at://<did>/<collection>/<rkey>`, required — obtain from `bsky_search_posts` or `bsky_get_author_feed`), `depth` (reply tree depth, default 6), `parent_height` (parent chain height, default 80) | `readOnlyHint: true` |
| `bsky_search_actors` | Find Bluesky accounts by name or handle fragment. Returns ranked profiles (handle, DID, displayName, description, follower count). Use before `bsky_get_profile` or `bsky_get_author_feed` when you have a name but not a confirmed handle. | `query` (required), `limit`, `cursor` | `readOnlyHint: true` |
| `bsky_get_follows` | Fetch the social graph edges for an account — who they follow or who follows them. Returns paginated profiles (handle, DID, displayName, description, follower count) plus the subject's profile summary. | `actor` (handle or DID, required), `direction` (followers\|following, required), `limit`, `cursor` | `readOnlyHint: true` |
| `bsky_get_trending` | Fetch real-time trending topics on Bluesky. Returns topics with display name, post count, category (politics, sports, pop-culture, etc.), status (hot/rising), and start time. Entry point for "what is Bluesky talking about right now" — pair with `bsky_search_posts` to drill into any trending topic. | `limit` (max results, default 10) | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `bsky://profile/{actor}` | A Bluesky actor's public profile, addressable by handle or DID. Same data as `bsky_get_profile` in injectable-context form. | None |

### Prompts

None for this launch. The tool surface is self-contained and goal-driven; no recurring interaction patterns warrant a fixed template.

---

## Overview

Bluesky MCP Server exposes the public AT Protocol AppView as a read-only MCP surface — full-text post search, actor profiles, author feeds, conversation threads, and social graph edges — all without authentication. The primary API is `https://api.bsky.app/xrpc/` (the keyless public AppView). Post data is identified by AT-URIs; accounts by handle or DID. The server is designed for social listening, trend analysis, journalist/researcher workflows, and any agent that needs "what is Bluesky saying about X."

---

## Requirements

- **Public reads only** — all seven tools operate against `api.bsky.app` with no credentials
- **No authentication required** at runtime for the core surface; no env vars required for launch
- Full-text post search with author, language, tag, domain, date, and sort filters
- Profile resolution (handle ↔ DID, bio, counts, avatar, labels)
- Author feeds filtered by post type
- Thread traversal by AT-URI (parent chain + reply tree)
- Actor discovery by name/handle fragment
- Social graph edges (followers/following), paginated
- AT Protocol identifier types exposed clearly: handle, DID, AT-URI
- Moderation labels surfaced on posts and profiles — not filtered silently
- Embeds (images, external link cards, quoted posts) normalized into a clean structure
- Pagination via opaque cursors on all list/search tools
- Rate limit: `api.bsky.app` is unauthenticated — service layer must use backoff and a descriptive `User-Agent`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `BlueskyService` | `https://api.bsky.app/xrpc/` — AT Protocol AppView public reads | All tools |

Single service, single upstream. All tools call through `getBlueskyService()`. Service holds an HTTP client configured with:
- Base URL: `https://api.bsky.app`
- `User-Agent: @cyanheads/bluesky-mcp-server/<version>`
- Retry: `withRetry`, base delay 500ms (rate-limit recovery), max 3 attempts
- Timeout: 15s via `fetchWithTimeout`

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| (none for public read surface) | — | All public-read tools work without credentials |

No `server-config.ts` needed for v0.1.0. The base URL and User-Agent are hardcoded in the service. An optional `BSKY_BASE_URL` override can be added later for self-hosted AppView or test environments.

---

## Implementation Order

1. **BlueskyService** — HTTP client with retry/timeout, `User-Agent`, base URL. Methods: `searchPosts`, `getProfile`, `getAuthorFeed`, `getPostThread`, `searchActors`, `getFollowers`, `getFollows`, `getTrends`.
2. **`bsky_get_profile`** — simplest single-entity GET; validates the service layer.
3. **`bsky_search_actors`** — second simplest; same actor shape as profile.
4. **`bsky_get_trending`** — single GET, simple flat result; no cursor needed.
5. **`bsky_get_author_feed`** — feed posts, filter enum, cursor pagination.
6. **`bsky_search_posts`** — most complex inputs (9 query params, embed normalization, 403 quirk note).
7. **`bsky_get_post_thread`** — recursive tree flattening; AT-URI validation.
8. **`bsky_get_follows`** — two-direction wrapper over `getFollowers`/`getFollows`.
9. **`bsky://profile/{actor}` resource** — thin read over `getProfile`.

Each step is independently testable.

---

## Domain Mapping

**Nouns and operations → XRPC methods:**

| Noun | Operations | XRPC endpoint |
|:-----|:-----------|:--------------|
| Post | search (full-text + filters) | `app.bsky.feed.searchPosts` |
| Profile (actor) | get by handle/DID | `app.bsky.actor.getProfile` |
| Feed | get author feed (filtered) | `app.bsky.feed.getAuthorFeed` |
| Thread | get by AT-URI (depth + parent) | `app.bsky.feed.getPostThread` |
| Actor | search by name/query | `app.bsky.actor.searchActors` |
| Social graph | get followers / get follows | `app.bsky.graph.getFollowers`, `app.bsky.graph.getFollows` |
| Trends | get real-time trending topics | `app.bsky.unspecced.getTrends` |

---

## Design Decisions

**1. api.bsky.app vs. public.api.bsky.app — confirmed by live probing.**
`public.api.bsky.app` returns HTTP 403 for `searchPosts` from certain IPs (Cloudflare CDN restriction, confirmed in live testing on 2026-06-04). All other XRPC methods (`getProfile`, `getAuthorFeed`, `getPostThread`, `searchActors`, `getFollowers`) work on both hosts. The service layer will use `api.bsky.app` as the base URL for all calls — it serves all endpoints correctly without the restriction. This is the production AppView with no extra auth requirement for public methods.

**2. `bsky_get_follows` consolidates two XRPC methods.**
`app.bsky.graph.getFollowers` and `app.bsky.graph.getFollows` are nearly identical in shape; the only difference is direction. One tool with a `direction` enum is cleaner than two tools that agents must choose between for no reason. The handler branches internally.

**3. Out of scope: authenticated posting.**
`bsky_create_post` (app password / OAuth, `com.atproto.repo.createRecord`) is excluded from this launch. It's inherently single-user, requires per-user credentials, and changes the server's hosting model (no longer keyless multi-tenant). Documented here as a future addition gated on a separate config mode.

**4. Out of scope: custom algorithmic feeds (`app.bsky.feed.getFeed`).**
Requires a feed generator DID/URI, which agents won't have without prior context. Not part of the core "what is Bluesky saying about X" workflow. Deferred to a future addition.

**5. No DataCanvas.**
The primary workflow is search/browse/read — categorical results (AT-URIs, handles, text), not analytical data an agent would SQL over. Canvas doesn't earn its keep here on shape, not just size.

**6. Embed normalization.**
Bluesky posts carry three embed types: images (`app.bsky.embed.images`), external link cards (`app.bsky.embed.external`), and quoted posts (`app.bsky.embed.record`). Raw embed objects are deeply nested. The service layer normalizes all three into a flat `Embed` union: `{ type: 'images' | 'external' | 'record' | 'unknown'; ... }` with the key fields the LLM needs (URLs, titles, alt text for images, quoted post text). This prevents raw `$type`-keyed objects from leaking into tool output.

**7. Moderation labels surfaced, not filtered.**
Posts and profiles carry `labels[]` from the AppView (content warnings, adult labels, etc.). The server surfaces them as-is — the agent and its human decide what to do. The server should not silently hide content the API marks.

**8. `bsky_get_trending` uses `app.bsky.unspecced.getTrends`.**
This endpoint is marked `unspecced` in the AT Protocol lexicon (not part of the stable Bluesky lexicon), meaning Bluesky may change it without notice. It is confirmed live as of 2026-06-04, returns rich trending data (topic, displayName, postCount, category, status, startedAt), and is directly aligned with the server's "trend analysis" stated purpose. Accepted: the utility is high and the risk of breakage is isolated to a single tool.

**9. AT Protocol identifier teaching responsibility.**
Agents will frequently have a handle but need a DID or AT-URI for other tools. `bsky_get_profile` is the resolution step — its description makes this explicit. `bsky_search_posts` returns AT-URIs for every post for direct thread drilling. Tool descriptions explain the three identifier types (handle, DID, AT-URI) at first encounter.

---

## Known Limitations

- **`searchPosts` result freshness**: The AppView indexes with some lag (seconds to minutes). Real-time posts may not appear immediately.
- **`getPostThread` depth cap**: The API returns a tree up to `depth` levels deep; very large threads are truncated at the leaves. The server surfaces `truncated: true` on reply nodes when the API sets `$type: "app.bsky.feed.defs#threadViewPostMore"`.
- **Social graph scale**: Accounts with millions of followers return only the first page (`limit` ≤ 100 per call). Pagination via cursor is the only path to the full set.
- **No full-text search history**: `searchPosts` covers roughly the last 30 days of indexed content; older posts are not searchable.
- **Unauthenticated rate limits**: The public AppView has undocumented rate limits. The service layer uses 3-attempt backoff at 500ms base; sustained high-volume use may hit limits.
- **`bsky_get_trending` uses an `unspecced` endpoint**: `app.bsky.unspecced.getTrends` is not part of Bluesky's stable lexicon and may change or be removed without notice. Confirmed live as of 2026-06-04.

---

## API Reference

**Endpoint base:** `https://api.bsky.app/xrpc/`

**Confirmed response shapes (live probe 2026-06-04):**

`getProfile` → `{ did, handle, displayName, description, avatar, banner, followersCount, followsCount, postsCount, labels, indexedAt, createdAt, associated, verification, pinnedPost? }`

`searchActors` → `{ actors: [{ did, handle, displayName, description, avatar, labels, createdAt, indexedAt, associated, verification }], cursor? }`

`getAuthorFeed` → `{ feed: [{ post: { uri, cid, author, record, bookmarkCount, replyCount, repostCount, likeCount, quoteCount, indexedAt, labels, embed? }, reply? }], cursor? }`

`getPostThread` → `{ thread: { post, replies: [...], parent? } }` — nested; reply nodes use `$type: "app.bsky.feed.defs#threadViewPost"` for present nodes, `threadViewPostMore` for truncated subtrees, `threadViewPostNotFound` for deleted posts.

`getFollowers` / `getFollows` → `{ followers|follows: [...actorProfiles], subject: actorProfile, cursor? }`

`searchPosts` → `{ posts: [...postViews], cursor?, hitsTotal? }` — same `postView` shape as feed entries; `hitsTotal` present when the API knows the total count.

`getTrends` → `{ trends: [{ topic, displayName, link, startedAt, postCount, status, category, actors: [...actorProfiles] }] }` — `status` observed values: `hot`; `category` observed values: `politics`, `sports`, `pop-culture`. No cursor — returns current snapshot up to `limit`.

**Error shape:** `{ "error": "InvalidRequest" | "AuthMissing" | ..., "message": "..." }` — no body on Cloudflare-level 403.

**Pagination:** all list/search methods use opaque string `cursor` — pass it back as-is.

**searchPosts filters (confirmed in lexicon):** `q` (required), `sort` (top|latest), `since` (ISO 8601), `until` (ISO 8601), `mentions` (DID), `author` (DID or handle), `lang` (BCP-47), `domain`, `url`, `tag`, `limit` (≤ 100).

---

## Error Contracts

Domain failure modes per tool — these map directly to `errors: [{ reason, code, when }]` in the tool definitions.

**`bsky_get_profile`**
- `actor_not_found` — `NotFound` — Actor handle resolves but profile doesn't exist, or the handle itself is invalid (API: `"Profile not found"` / `InvalidRequest`). Recovery: verify the handle spelling or use `bsky_search_actors` to find the correct handle.

**`bsky_get_author_feed`**
- `actor_not_found` — `NotFound` — Actor does not exist. Recovery: verify the handle or DID, or use `bsky_search_actors` to find the correct actor.

**`bsky_get_post_thread`**
- `invalid_at_uri` — `InvalidParams` — `uri` parameter is not a valid AT-URI (`at://did:*/collection/rkey` format). API returns `InvalidRequest`. Recovery: AT-URIs come from post `uri` fields returned by `bsky_search_posts` or `bsky_get_author_feed` — obtain one from there.
- `post_not_found` — `NotFound` — Post AT-URI is valid format but the post was deleted or never existed. Recovery: verify the AT-URI or search for the post with `bsky_search_posts`.

**`bsky_get_follows`**
- `actor_not_found` — `NotFound` — Actor handle or DID does not exist. Recovery: verify the actor or use `bsky_search_actors` to confirm the handle.

**`bsky_search_posts`**, **`bsky_search_actors`**, **`bsky_get_trending`**
- No domain-specific error contracts beyond baseline (`ServiceUnavailable` for upstream failures, `ValidationError` for invalid param values). These endpoints return empty results rather than errors for zero-match queries.

# Bluesky MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `bsky_search_posts` | Full-text search across public Bluesky posts. Filters by author, language, hashtag, date range, and sort order. Returns posts with text, author, engagement counts (likes/reposts/replies), embeds, AT-URIs, timestamps, and `hitsTotal` when available (total matching posts, not just the current page — use for communicating result scale). Registered only when an app password is configured, and runs as that account (decision 21). | `query` (required), `author_handle`, `language`, `tag`, `since`, `until`, `sort` (enum: `top`\|`latest`, default `latest`), `limit` (≤100), `cursor` | `readOnlyHint: true` |
| `bsky_get_profile` | Fetch a Bluesky actor's public profile by handle or DID. Returns displayName, handle, DID, description, pronouns, website, follower/following/post counts, avatar URL, labels (moderation), and pinned post AT-URI. Resolves handle↔DID — use before tools that require a DID or AT-URI when you only have a handle. | `actor` (handle or DID, required) | `readOnlyHint: true` |
| `bsky_get_feed` | Read the posts a feed generator serves — a trend's feed, Discover, a feed quoted in a post, or any custom feed — in the order it ranks them. Pinned items carry `pinned: true`, reposts `repostedBy`/`repostedAt`. Always unauthenticated (decision 22). | `feed` (generator AT-URI or bsky.app feed URL, handle or DID owner, required), `limit` (≤100, default 25), `cursor` | `readOnlyHint: true`, `openWorldHint: true` |
| `bsky_get_author_feed` | A user's recent feed ordered newest-first — their own posts and their reposts. Filter by post type to exclude replies, restrict to posts with media, or take everything; no filter excludes reposts, which carry `repostedBy`/`repostedAt`. Enrichment reports the `originalPosts` / `reposts` split of the page, since `limit` counts both. Returns posts with full text, engagement, embeds, and AT-URIs for thread drilling. | `actor` (handle or DID, required), `filter` (posts\_with\_replies\|posts\_no\_replies\|posts\_with\_media\|posts\_and\_author\_threads), `limit`, `cursor` | `readOnlyHint: true` |
| `bsky_get_post_thread` | Fetch the conversation for a post by AT-URI — the parent chain upward and the reply tree downward. Useful for reading a discussion from any entry point. Returns root post, parent chain, and nested replies with per-post author and engagement data, the author's reply gate when one is set, and both ways the response falls short: per-node `truncated` / `unreturnedReplies` / `truncationReason` for the reply tree, `parentChainTruncated` on the topmost parent when the chain was cut, and a thread-wide total in enrichment. | `uri` (AT-URI matching `at://<handle-or-did>/<collection>/<rkey>`, required — obtain from the `uri` field of any returned post), `depth` (reply tree depth, default 6, max 10), `parent_height` (parent chain height, default 80, max 100) | `readOnlyHint: true` |
| `bsky_search_actors` | Find Bluesky accounts by name or handle fragment. Returns ranked profiles (handle, DID, displayName, description, pronouns when set) — counts and website are `bsky_get_profile`'s (decision 25). Use before `bsky_get_profile` or `bsky_get_author_feed` when you have a name but not a confirmed handle. | `query` (required), `limit`, `cursor` | `readOnlyHint: true` |
| `bsky_get_follows` | Fetch the social graph edges for an account — who they follow or who follows them. Returns paginated profiles (handle, DID, displayName, description, pronouns when set) plus the subject's profile summary — counts and website are `bsky_get_profile`'s (decision 25). | `actor` (handle or DID, required), `direction` (followers\|following, required), `limit`, `cursor` | `readOnlyHint: true` |
| `bsky_get_trending` | Fetch real-time trending topics on Bluesky. Returns topics with display name, Bluesky's one-sentence story summary, post count, category (politics, sports, pop-culture, etc.), status (e.g. hot, cooling, stale), start time, the representative accounts driving each topic, and `feedUri` — the AT-URI of the feed that collects the trend's posts. Entry point for "what is Bluesky talking about right now" — pass a `feedUri` to `bsky_get_feed` to drill into a trend (decision 23). | `limit` (default 10, max 25 — Bluesky's own maximum) | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `bsky://profile/{actor}` | A Bluesky actor's public profile, addressable by handle or DID. Same data as `bsky_get_profile` in injectable-context form. | None |

### Prompts

None for this launch. The tool surface is self-contained and goal-driven; no recurring interaction patterns warrant a fixed template.

---

## Overview

Bluesky MCP Server exposes the AT Protocol AppView as a read-only MCP surface — actor profiles, trending topics and the feeds behind them, custom feeds, author feeds, conversation threads, and social graph edges without authentication, plus full-text post search when an app password is configured. The primary API is `https://api.bsky.app/xrpc/` (the keyless public AppView); post search goes through the configured account's PDS. Post data is identified by AT-URIs; accounts by handle or DID. The server is designed for social listening, trend analysis, journalist/researcher workflows, and any agent that needs "what is Bluesky saying about X."

---

## Requirements

- **Public reads by default** — seven of the eight tools operate against `api.bsky.app` with no credentials
- **No authentication required** at runtime for the core surface; no env vars required for launch
- Full-text post search with author, language, tag, date, and sort filters, behind an optional app password (Bluesky refuses search without a signed-in account)
- Custom and trending feeds readable by AT-URI or bsky.app URL
- Profile resolution (handle ↔ DID, bio, counts, avatar, labels)
- Author feeds filtered by post type
- Thread traversal by AT-URI (parent chain + reply tree)
- Actor discovery by name/handle fragment
- Social graph edges (followers/following), paginated
- AT Protocol identifier types exposed clearly: handle, DID, AT-URI
- Moderation labels surfaced on posts and profiles — not filtered silently
- Embeds (images, external link cards, quoted posts and their own attachments) normalized into a clean structure
- Pagination via opaque cursors on all list/search tools
- Rate limit: `api.bsky.app` is unauthenticated — service layer must use backoff and a descriptive `User-Agent`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `BlueskyService` | `https://api.bsky.app/xrpc/` — AT Protocol AppView public reads; for post search, `https://bsky.social` (login) and the session account's PDS | All tools |

Single service. All tools call through `getBlueskyService()`. Service holds an HTTP client configured with:
- Base URL: `https://api.bsky.app` for every read but post search
- `User-Agent: @cyanheads/bluesky-mcp-server/<version>`
- Retry: `withRetry`, base delay 500ms (rate-limit recovery), max 3 retries — skipped for a failure already mapped onto a tool's declared reason, and never used for a login or refresh
- Timeout: 15s via `fetchWithTimeout`
- Error data scrubbed of HTML: an edge block page captured as the error body is dropped, leaving the status

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `BLUESKY_IDENTIFIER` | No | Handle, DID, or email of the account post search runs as |
| `BLUESKY_APP_PASSWORD` | No | App password for that account |

`src/config/server-config.ts` parses the pair with `parseEnvConfig`, so a blank value — what an MCPB or plugin host forwards for an option left empty — reads as unset. Both set enables post search; neither leaves it off; one without the other fails startup with a `ConfigurationError` that names the missing variable, since half a login cannot enable search and quietly leaving it off would hide the typo. The pair is read before `createApp()`, because the tool list depends on it; a failed read builds the list with search off and is raised again from `setup()`, so it reaches the framework's configuration-error banner instead of a raw stack. The base URLs and User-Agent are hardcoded in the service.

---

## Implementation Order

1. **BlueskyService** — HTTP client with retry/timeout, `User-Agent`, base URL. Methods: `searchPosts`, `getProfile`, `getAuthorFeed`, `getFeed`, `getPostThread`, `searchActors`, `getFollowers`, `getFollows`, `getTrends`.
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
| Post | search (full-text + filters), as the configured account | `app.bsky.feed.searchPosts` via the account's PDS |
| Session | log in, refresh (post search only) | `com.atproto.server.createSession`, `com.atproto.server.refreshSession` |
| Profile (actor) | get by handle/DID | `app.bsky.actor.getProfile` |
| Handle | resolve to DID (feed owner) | `com.atproto.identity.resolveHandle` |
| Feed | get author feed (filtered) | `app.bsky.feed.getAuthorFeed` |
| Feed generator | get its posts | `app.bsky.feed.getFeed` |
| Thread | get by AT-URI (depth + parent) | `app.bsky.feed.getPostThread` |
| Actor | search by name/query | `app.bsky.actor.searchActors` |
| Social graph | get followers / get follows | `app.bsky.graph.getFollowers`, `app.bsky.graph.getFollows` |
| Trends | get real-time trending topics | `app.bsky.unspecced.getTrends` |

---

## Design Decisions

**1. api.bsky.app vs. public.api.bsky.app — confirmed by live probing.**
`public.api.bsky.app` returned HTTP 403 for `searchPosts` from certain IPs (Cloudflare CDN restriction, confirmed in live testing on 2026-06-04), so the service used `api.bsky.app` for every call. As of 2026-09-25 both hosts refuse unauthenticated `searchPosts` with a 403 HTML page, first pages included; decision 21 covers the authenticated path that replaced it. Every other method used here (`getProfile`, `getAuthorFeed`, `getFeed`, `getPostThread`, `searchActors`, `getFollowers`, `getTrends`, `resolveHandle`) still answers keyless on `api.bsky.app`, which remains the base URL for them.

**2. `bsky_get_follows` consolidates two XRPC methods.**
`app.bsky.graph.getFollowers` and `app.bsky.graph.getFollows` are nearly identical in shape; the only difference is direction. One tool with a `direction` enum is cleaner than two tools that agents must choose between for no reason. The handler branches internally.

**3. Out of scope: authenticated posting.**
`bsky_create_post` (app password / OAuth, `com.atproto.repo.createRecord`) is excluded from this launch. It's inherently single-user, requires per-user credentials, and changes the server's hosting model (no longer keyless multi-tenant). Documented here as a future addition gated on a separate config mode.

**4. Custom feeds are read through `bsky_get_feed` (was: out of scope).**
The original objection — agents won't have a feed generator URI without prior context — stopped holding once trends turned out to be feeds (decision 23): every trend hands the agent a readable feed URI, and quoted feeds and shared bsky.app feed links hand it others. With unauthenticated search refused (decision 21), a feed is also the one keyless path to posts on a topic. Decision 22 covers the tool's design.

**5. No DataCanvas.**
The primary workflow is search/browse/read — categorical results (AT-URIs, handles, text), not analytical data an agent would SQL over. Canvas doesn't earn its keep here on shape, not just size.

**6. Embed normalization.**
Raw AT Protocol embed objects are deeply nested and `$type`-keyed. The service layer flattens every embed view the AppView returns into a five-member `Embed` union — `{ type: 'images' | 'external' | 'record' | 'video' | 'unknown'; ... }` — carrying the fields the LLM needs (image URLs and alt text, link card title and description, quoted post URI, CID, author, and text, video playlist and thumbnail), alongside the discriminants and disclosure fields below. What the upstream views carry that this union does not is decision 20. Two lexicon types fold onto existing members rather than adding discriminants: `app.bsky.embed.gallery#view` maps its `items[]` onto `images` (its per-item small variant is named `thumbnail`, not `thumb`), and `app.bsky.embed.recordWithMedia#view` maps onto `record` — unwrapping the quote from `record.record`, one level deeper than a plain `record#view` — with its attached media recursed through the same normalizer and nested under `media`.

Dispatch matches the NSID exactly (`app.bsky.embed.<family>`, `#view` suffix stripped) rather than testing for a substring. A substring test is what let `recordWithMedia` be swallowed by the `record` branch, and it silently mis-sorts the next lexicon addition that shares a prefix. Anything unrecognized becomes `{ type: 'unknown', raw: '<$type>' }` and renders in `content[]`, so a new embed type shows up as visibly unhandled instead of disappearing.

A quoted post carries its own attachments in `app.bsky.embed.record#viewRecord.embeds`, which the normalizer maps onto `record.embeds` through the same recursion. Without it a quote of an image post reached both channels as a bare handful of words with no marker that any media was there. The lexicon bounds the nesting at nothing — that `embeds` field is a union that readmits `record#view` and `recordWithMedia#view`, so a quoted post may declare a quoted post forever — but the AppView does not go that far. Sampled twice on different days — 793 posts carrying 84 quotes, then 797 carrying 61 — an `embeds` key appeared only on the record a post quotes directly, never on one nested below that. Two levels therefore cover everything it sends, since a quoted post's `embeds` may itself hold a `recordWithMedia#view` whose attached media sits one deeper. `MAX_EMBED_DEPTH` is set to 3 — one level of headroom — which bounds both the recursion and the payload against an upstream that changes shape.

A bound that fires silently would reintroduce the defect this change removes one level further down, so it does not fire silently: a quote at the bound reports what it left as `omittedEmbeds` and states it in the rendered text under the AT-URI to re-root at. On everything the AppView has been observed to send the field is absent, which is the point — an unattached quote and a quote whose attachments are missing are never the same value. The cost of carrying the attachments themselves, measured over live responses: +1.7% of `structuredContent` and +1.5% of the rendered `content[]` on a 100-post author feed, +2.2% on both channels of a 100-post search page, and +6.6% / +5.9% on the most quote-heavy feed sampled. A feed with no quotes on it costs nothing at all.

The two attachment blocks under a quote belong to different posts — `embeds` to the post being quoted, `media` to the post doing the quoting — so `format()` names each. Unlabelled they render as two image blocks under one `💬` heading with nothing to say whose they are, which is a worse failure than the one this fixed.

The quote slot inside `app.bsky.embed.record#view` is itself a union, and only one of its eight members — `#viewRecord` — is an ordinary quoted post. The rest are `#viewNotFound` (deleted), `#viewBlocked`, `#viewDetached`, and the feed-generator, list, starter-pack, and labeler views, none of which carry the `cid` / `value.text` / `author.handle` fields the quote normalizer reads. Read blind they collapse into a `record` embed with an empty `cid` and no text — indistinguishable from a quote whose text merely was not returned, and rendered as an ordinary quote. The normalized `record` embed therefore carries an optional `recordKind` naming which member arrived (`notFound` | `blocked` | `detached` | `generator` | `list` | `starterPack` | `labeler` | `unknown`), absent for the ordinary case so the common path is unchanged, and `format()` states the case instead of emitting an empty quote line. A member added to the union upstream lands on `unknown` rather than being presented as a post.

**7. Moderation labels surfaced, not filtered.**
Posts and profiles carry `labels[]` from the AppView (content warnings, adult labels, etc.). The server surfaces them as-is — the agent and its human decide what to do. The server should not silently hide content the API marks.

**8. `bsky_get_trending` uses `app.bsky.unspecced.getTrends`.**
This endpoint is marked `unspecced` in the AT Protocol lexicon (not part of the stable Bluesky lexicon), meaning Bluesky may change it without notice. It is confirmed live as of 2026-06-04, returns rich trending data (topic, displayName, postCount, category, status, startedAt), and is directly aligned with the server's "trend analysis" stated purpose. Accepted: the utility is high and the risk of breakage is isolated to a single tool.

Each trend also carries five representative accounts, which the tool surfaces as `actors` — "who is talking about this" is answered in the same response instead of costing a round trip through the trend's posts and a scan of their authors. Only `did`, `handle`, and `displayName` are kept from the profile view the endpoint returns: `format()` must render every schema field, and at 5 actors × up to 25 trends the avatar URLs are decoration that would dominate both channels. `bsky_get_profile` serves the full profile for any handle worth following up.

**9. AT Protocol identifier teaching responsibility.**
Agents will frequently have a handle but need a DID or AT-URI for other tools. `bsky_get_profile` is the resolution step — its description makes this explicit. Every post-returning tool carries each post's AT-URI for direct thread drilling. Tool descriptions explain the three identifier types (handle, DID, AT-URI) at first encounter.

**10. Identifier and date syntax validated locally, calibrated against measured AppView behavior.**
`src/services/bluesky/at-syntax.ts` holds the AT-identifier, AT-URI, non-blank, and date patterns shared by every input schema, so they also ship as JSON Schema `pattern` constraints in `tools/list`. The patterns are set to exactly what the AppView honours, never tighter — an over-strict pattern turns a working call into an unrecoverable `-32602`. Two calibrations worth preserving: the AT-URI authority accepts a **handle as well as a DID** for posts (`at://bsky.app/app.bsky.feed.post/<rkey>` resolves) — but not for feeds, where `getFeed` answers a handle authority with `could not find feed`, so `bsky_get_feed` resolves the handle first (decision 22) — and the date filters accept an **unpadded month or day in the date-only form** (`2025-1-1` filters identically to `2025-01-01`) but require zero-padding once a time component is present (`2025-1-1T00:00:00Z` is silently dropped and returns unfiltered results). Re-measure before tightening either.

**11. One post renderer behind every `format()`.**
`bsky_search_posts`, `bsky_get_author_feed`, and `bsky_get_post_thread` all emit posts into `content[]`, and each had its own copy of the rendering. The copies drifted: the thread formatter rendered no embeds, no CID, no author DID, no quote count, and no indexed timestamp, so a `content[]`-only client saw a materially thinner thread than a `structuredContent` client did. `src/mcp-server/tools/post-format.ts` now owns rendering one post as markdown lines, and `bsky_get_feed` renders through it too; each tool owns only what genuinely differs — the search header and cursor footer, the feeds' separators, the thread's section headings and per-depth indentation. Its parameter type is structural rather than the service-layer `PostView`, so both the domain type and each tool's Zod-inferred post shape satisfy it without a cast.

**12. Each thread node renders once, under exactly one heading.**
`bsky_get_post_thread`'s `format()` splits the conversation into `## Parent chain` (ancestors, oldest first, replies stripped so a sibling branch is not pulled in), `## This post` (the target alone), and `## Replies` (the reply tree). The section walker recurses through `replies` itself, so the target must be rendered with its own `replies` stripped — otherwise `## This post` emits the whole subtree and `## Replies` emits it again, doubling the rendered text while `structuredContent` stays correct. Three headings is one more than the tree strictly needs, and they earn it: without them a reader has no way to tell the target from the ancestors above it and the replies below.

**13. What the response is missing is derived from `replyCount`, and reported as a bound rather than a cause.**
The `thread` / `parent` / `replies` slots of `app.bsky.feed.getPostThread` are one three-member union — `#threadViewPost`, `#notFoundPost`, `#blockedPost` — with no "more replies" stub, so there is nothing to key a truncation marker on. `normalizeThread` compares each node's own `post.replyCount` against the replies it actually received and reports the difference as `unreturnedReplies`. The `replies` key separates the recoverable case from the rest: the AppView omits it entirely at the deepest level it will return and emits it (short, or empty) at every level above, so a missing key means the tree ended there (`truncationReason: 'depth'`, recoverable by re-rooting a request at that node's AT-URI — 24 of 25 sampled edge nodes returned replies when re-rooted).

A present key with a short array is reported as `'unavailable'`, deliberately naming no cause. `replyCount` is a broader number than "replies that exist and were held back": walking 748 live threads (94,366 nodes) found 1,930 shortfall nodes carrying a `replyCount` of 3 or less, and 1,244 reporting `replyCount: 1` beside an empty `replies` array — far below the 166–200 replies the per-post limit actually returns on high-fan-out nodes. Re-rooting those nodes reproduces the empty array, `app.bsky.unspecced.getPostThreadV2` answers `hasOtherReplies: false`, and `getPostThreadOtherV2` returns nothing: the AppView's own accounting says nothing is being held back, so the counter is simply still including replies that have left the index — deleted, from a departed account, hidden by the author, or filtered by moderation. Naming the per-post limit as the cause would have published a fabricated explanation on 54 of those 748 threads, whose entire reported shortfall sits on nodes too small for the limit to bind. So the number ships as an upper bound on what is missing, the prose lists both causes without choosing between them, and the one claim that holds either way — that no further request closes the gap — is the actionable part. The comparison is suppressed while walking the parent chain: a parent always has replies the request never asked for, and parent nodes carry no `replies` key of their own, so nothing below them is skipped. `format()` renders the shortfall inline under the node it belongs to, and the handler totals it across the thread into enrichment.

**14. `depth` maxes at the AppView's own tree cap; `parent_height` at a measured practical ceiling.**
Both parameters accept up to 1000 upstream, and 1001 is a hard `InvalidRequest`, so neither new bound can ever be the more permissive of the two. They behave nothing alike below that. `depth` is silently ignored past 10: walking 748 threads at `depth` 1000 — deep narrow chains, wide shallow trees, quoted and gated threads, 94,366 nodes in all — never returned a reply below level 10, and a 1,805-reply thread comes back byte-identical at `depth` 10, 20, 50, and 1000 (365 nodes, 10 levels) while re-rooting at a level-10 node proves the tree continues below. So `depth` maxes at 10; advertising more would promise levels the AppView will not send, and would not widen the tree either, since the per-post reply limit is independent of depth. `parent_height` *is* honored level for level (a request for 9 returns 9, for 15 returns the 10 that exist), so its bound is a cost decision: chains cost roughly 1.5 KB upstream per level, and 244 sampled live replies put the median chain at 1 post, p90 at 11, and p99 at 96. 100 covers that instead of the 1000 that would admit a megabyte of ancestors. Chains beyond it do exist — the longest sampled ran 645 posts — and unlike the reply-tree cap this one is recoverable: re-rooting at the topmost parent returned continues upward. Neither default moves — 6 and 80 are the lexicon defaults and already exceed what most conversations hold.

**15. The threadgate ships with the thread, because it is the one missing-reply cause attributable to a person.**
`getPostThread` returns a `threadgate` beside `thread` whenever the author restricted or curated replies — 88 of the same 748 sampled threads carried one, 59 of those with `hiddenReplies`. It matters to the accounting: of 106 sampled hidden replies that still exist, 54 were absent from the returned tree while their parent was present, and they stay counted in `replyCount` either way. Left undisclosed they would have been folded silently into the unexplained difference. The gate normalizes to `{ uri, allow?, hiddenReplies }`; an absent `allow` (anyone may reply) is kept distinct from an empty one (replies turned off), since collapsing both to "open" loses the author's actual choice. The other 52 hidden replies were still in the tree, so the handler credits a hidden reply against the shortfall only when its AT-URI is genuinely absent from the returned nodes — trusting the list wholesale would over-explain the gap in half the cases. `format()` leads with the gate in every branch, including a deleted target, since the restriction outlives the post. Each rule renders as its plain-language audience followed by its own `allow` value — the gloss alone leaves a client reading `content[]` no way back to the machine value `structuredContent` carries, and two of the five glosses ("accounts the author follows", "an audience this server does not recognize") do not contain their rule as a word at all.

**16. Bluesky-authored text is framed as a blockquote, and blank lines inside it stay quoted.**
Post bodies, quoted-post bodies, profile bios, image alt text, and link-card titles and descriptions are public user-generated content, and every formatter previously pushed them into `content[]` as bare markdown — in the same channel as the server's own `###` author headings and `---` post separators. `quoteUserText()` in `post-format.ts` prefixes every line with `> `. Blockquote over fenced code: live posts contain their own triple-backtick fences (a post opening ` ```markdown ` was found in search), and a fence-based frame lets that content close the fence early and continue outside it, whereas a `>`-prefixed line that itself starts with `>` only nests deeper. The blank-line case is the one that decides whether the frame holds at all — an unprefixed blank line ends the blockquote, so a post carrying `---` and `### Heading` after a blank line would emit a real top-level rule and heading. Blank lines therefore render as a bare `>`, which also keeps trailing whitespace out of the output. Empty text returns no lines, so an image-only post gets no stray marker.

Scope follows the lexicon rather than intuition about which fields "look like" prose. `app.bsky.embed.images#image.alt` and `app.bsky.embed.external#external.title`/`.description` carry no length bound and no character restriction at all, and the poster sets all three — a link card's title and description are taken from the record, not fetched from the linked page. They are ordinary multi-line values in practice: across 1,989 live posts sampled from twenty search terms, 54 of 633 alt strings and 28 of 626 link-card descriptions contained a line break, the longest alt running 1,850 characters and the longest description 20,754. Each therefore gets quoted lines of its own. That splits the images apart, since a per-image quote block has nothing to hang off the old comma-joined `url [alt]` list, and it retires the `[title](uri)` markdown link on the link card — the URL renders bare, so no part of the card can close the link syntax and continue outside it.

The cost measured over live responses, comparing the rendered `content[]` against the same `structuredContent` re-rendered through the pre-framing renderer: +1.44% on a 97-post search page, +1.82% on a 50-post author feed, +1.77% on an 883-node thread, and +1.43% across 99 actor profiles. `structuredContent` is untouched — it carries the raw strings, so the two channels stay in parity and a client reading either sees the same content. `createApp({ instructions })` states the convention once at session level rather than repeating it per tool description.

**Values that render inside a line get the other framing.** `displayName` in a `###` author heading, a profile's `pronouns`, a trend's topic name, a moderation label's `val` — a blockquote is the wrong shape for these, since quoting them would push the heading or label they belong to onto a line of its own. `inlineUserText()` folds their line breaks to spaces instead, which is the only escape those positions are open to, and strips nothing else. This is not hypothetical: `app.bsky.actor.profile` bounds `displayName` by graphemes alone (64) and excludes no character, and 1 of 3,929 live display names sampled already carried a line break; `pronouns` is bounded the same way at 20 graphemes with no character restriction. `label.val` is bounded at 128 characters with no pattern and is written by third-party labelers, which live data confirms is no controlled vocabulary — `reaction_count:19` and `Adult Content` both appear. Two identity fields are left alone, both because the lexicon types them: `handle` carries `format: "handle"`, so it is a dotted domain by construction, and `website` carries `format: "uri"`, which is why it renders bare on the same terms as the avatar URL rather than being quoted.

**17. Depth is carried in the text, not the left margin.**
Rendering the reply tree by indenting two spaces per level put every line of a node at depth 2 or deeper past four leading spaces, which CommonMark reads as an indented code block. From there down the rendered thread stopped being markdown: author headings, quoted-post blockquotes, and the truncation notices all became literal preformatted text — 109 of the lines returned for one three-level thread. The blockquote framing was the real casualty, since a quote rendered inside a code block is characters rather than a quote, which is exactly the collision decision 16 exists to prevent.

The margin had no room to give because it was already spent: `renderEmbedLines()` indents its own detail lines three spaces, and nesting an embed inside an embed used to stack another three, so a quote-with-media on a *depth 0* post already crossed the threshold before any thread indentation was applied. Three spaces is the whole budget, and only one level of anything can spend it.

So depth moved into the author heading — `### ↳2 Display Name (@handle)`, two levels below the top-level reply that node descends from — and every line of every node now sits at column zero. The number is written out rather than repeated as a glyph: `depth` maxes at 10 and the AppView returns no more than 10 levels, so a marker can reach nine, and nine identical arrows have to be counted to be read — the same failure as an indent, moved one channel over. Document order carries the rest of the shape, since the walk is strictly pre-order; each post also names its own parent on its `↩ Reply to` line, so the tree is recoverable from `content[]` without relying on either. Embed detail lines keep the single three-space column, and an embed nested inside another (a quoted post's own attachments, or the media beside a quote) reuses that same column rather than adding to it, distinguished by a label and by the `📷` / `🔗` / `💬` marker that introduces each block. Nesting reads less steeply than an indent would, which is the price; nothing is dropped to pay it, and `structuredContent` carries the tree shape in `parent` / `replies` regardless. The `>`-nesting alternative was rejected for a subtler reason than legibility: prefixing structural lines with `>` puts the server's own headings *inside* a blockquote, erasing the one distinction between what the server wrote and what a Bluesky user did.

**18. The parent chain discloses its own cut, in the vocabulary already there.**
`getPostThread` stops the parent chain at the requested `parentHeight` and emits no marker, so the topmost returned parent is indistinguishable from a conversation root — an agent reading a long chain names the wrong first post and names it as certain. Chains long enough to bind are uncommon but real: of 244 sampled live replies the median chain was 1 post and the 99th percentile 96, with a maximum of 645.

The signal is already in the response. A node on the parent spine that carries a `replyToUri` and no `parent` of its own replies to a post the response does not contain, so `normalizeThread` sets `parentChainTruncated` there. The test has to be confined to the spine: every reply-tree node also has a `replyToUri` and no `parent`, and none of them is a cut — which is why the position a node holds (`target` / `parent` / `reply`) is threaded through the walk rather than a single "in the parent chain" flag. The target itself takes the marker when no parent came back at all, which is the same fact at height 0.

It rides the existing disclosure rather than a parallel one: an inline `*[…]*` line above the node it belongs to, a sentence folded into the same enrichment `notice`, and one `parentChainTruncated` enrichment field beside `truncated`. What it does not reuse is `truncationReason` — that field pairs with `unreturnedReplies`, a count this axis has no equivalent of, and its two values both mean something the reply tree does. The prose keeps the axes apart on the point that matters: `parentHeight` is honored level for level, so this shortfall is fully recoverable by re-rooting at the named AT-URI, where the reply-cap shortfall is not recoverable by any request. The notice now fires when either axis has something to say, not only when the reply counts run ahead.

**19. The author feed reports its own yield.**
`app.bsky.feed.getAuthorFeed` has no parameter that excludes reposts and every `filter` value returns them, so `limit` counts posts the actor wrote and posts they merely shared as one. A 30-item pull from an account that reposts heavily came back as 10 originals and 20 reposts. The enrichment previously reported only how many items arrived — the number least useful for deciding whether to page again.

`originalPosts` and `reposts` are counted from the repost markers already on each item, so the split costs no second request. It is reported only when the page carries at least one repost: on a page that is entirely the actor's own writing, `totalReturned` already says it, and a pair of numbers that never varies is noise. Filtering the reposts out server-side stays rejected for the reason it always was — it would silently break `limit`.

**20. What the embed union carries is what `format()` renders — the rest is left upstream.**
Four fields of the normalized embed reached `structuredContent` and no formatter rendered them: `images[].aspectRatio`, `external.thumb`, `video.aspectRatio`, and `record.cid`. The linter did not catch it because an embed is declared as a passthrough object whose sub-fields live in the description prose, so `format-parity` walks none of them — parity below that line is held by hand or not at all. Both directions close a gap, and each field was decided on which one it earns.

`aspectRatio` on an image or a video is the pixel geometry of an asset the reader cannot see, and the asset carries its own dimensions to anything that fetches it. It is not rare — 202 of 221 images and 9 of 12 videos across 499 live search results — so rendering it would put a dimension pair on nearly every image in a response and tell a reader nothing they can act on. It is dropped in normalization rather than declared and skipped, so neither channel carries it.

`external.thumb` is dropped for a different reason. It is a fetchable URL, but it is the only URL in the union that is not the handle on its own attachment: an image post may carry no text at all, and a video's `playlist` is an HLS manifest, so for both the URL is the content. A link card's content is the page, and its `uri`, `title`, and `description` are already rendered — the thumb is a picture of a page the reader can already reach. It is also the most expensive of the four: a `cdn.bsky.app` thumbnail URL is a fixed 138 characters — a constant prefix, the poster's DID, and the blob CID, with no variation across 162 sampled — on 433 of 480 sampled cards.

`record.cid` is rendered instead. It addresses a record rather than describing an asset: it names the revision of the post a quote points at, the same `AT-URI | CID` pair `renderPostLines()` emits for every post, and the quote block was the one post-shaped block in the rendered output that named no CID. It rides the heading line the AT-URI already occupies — no new line, no new indent level — and is omitted when empty, since the union members standing in for an unreadable or non-post record carry no record of their own and an empty pair reads as a CID that failed to load.

The same audit found the wider version of the gap one level up, on the post author. `bsky_get_post_thread` declares its node tree as `z.object({}).passthrough()`, so where the search and feed tools declare a closed post schema that strips whatever it does not name, the thread tool passes the node through whole. The AppView attaches an `app.bsky.actor.defs#profileViewBasic` to every post view, and its account-level fields rode along: `createdAt` on all 733 nodes of a sampled thread, account moderation `labels` on 263, `pronouns` on 21 — named by no schema, rendered by no formatter, and absent from the two sibling tools' output for the same posts. A post view now normalizes its author to the four fields every post schema declares and the renderer emits (`did`, `handle`, `displayName?`, `avatar?`). Rendering the author's account labels instead was the one alternative worth weighing, since decision 7 surfaces moderation labels rather than filtering them — but a post already carries its own `labels[]`, which is what moderation applied to the post, and the account-level list is nearly all self-applied: 254 of the 263 labelled authors in that thread carried only `!no-unauthenticated`, leaving nine across 733 accounts (`bot`, `porn`, `nudity`, `rude`) to pay for a line on every post. `ActorProfile` is untouched for `bsky_get_profile`, `bsky_search_actors`, `bsky_get_follows`, and the profile resource — account-level detail is a profile lookup, and every post carries the handle and DID to make one.

A post's own moderation labels were the last field the audit turned up, and they resolve the other way. `normalizeLabel` carries `src` and `cts` beside `val` — which labeler applied the label, and when — while `renderPostLines()` emitted the value alone, so the two closed post schemas stripped the pair and the thread's passthrough shipped it unrendered. These describe the post rather than the account: `src` is what separates a label an account applied to its own post from one a labeler service applied to it, the same distinction that decided the account-label question above, and decision 7 keeps moderation data visible rather than filtered. `bsky_get_profile` already rendered both on a profile's labels, so the post renderer emits that same `val src:… cts:…` form and both post schemas declare the pair. Carrying it costs close to nothing, because a labelled post is uncommon: 2 of 96 posts on one search page and 3 of 94 on another, none on a 100-item author feed, none across a 264-node thread.

Measured against the 0.2.2 build on three fixed requests, each replayed through both builds. A 96-post search page — `q=the`, `limit=100`, bounded to the hour after `2025-06-01T00:00:00Z` so the same posts come back on every run, carrying five quotes and two labelled posts — grew `content[]` by 477 bytes (+0.5%) against −4,681 of `structuredContent` (−4.8%). A 100-item author feed (`bsky.app`, `posts_with_replies`, 24 quotes, no labelled post): +1,656 (+1.7%) against −4,109 (−3.9%). A 264-node thread rendering to 3,183 lines, with one quote and no labelled post: +69 (+0.0%) against −17,430 (−7.0%). The rendered channel grows only where a quote or a labelled post is, the structured channel loses what only it was carrying, and neither response gained a line — every addition rides one that was already there.

**21. Post search runs through an optional app-password session, and is gated off without one.**
As of 2026-09-25 Bluesky's edge refuses unauthenticated `app.bsky.feed.searchPosts` on both `api.bsky.app` and `public.api.bsky.app` with a 403 HTML page, first pages included, and the lexicon now says the endpoint "may require authentication". Every other read used here stayed keyless. Decisions:

- *Credentials:* optional `BLUESKY_IDENTIFIER` / `BLUESKY_APP_PASSWORD` (see Config). An app password, not OAuth: the server needs one read-only account, not a user's delegated identity.
- *Route:* `createSession` at the `bsky.social` entryway, then `searchPosts` to the PDS named in the session's DID document with the access token and `atproto-proxy: did:web:api.bsky.app#bsky_appview`. The documented alternatives were rejected: the entryway works but the docs send non-session traffic to the PDS, and an AppView-direct bearer works only because the AppView temporarily accepts entryway-issued tokens. A session with no https PDS in its DID document falls back to the entryway.
- *Lifecycle:* `createSession` answered `ratelimit-policy: 10;w=86400` per identifier, stricter than the documented limit, and the operator's own automation may share that budget. So the session is created on the first search and never at startup, reused by every later search, and shared by concurrent first searches through one in-flight promise. A refused access token (`400 ExpiredToken`/`InvalidToken`, or `401`) is renewed once with `refreshSession`, which rotates both tokens; a refused refresh falls back to one new `createSession`; a refusal after renewal ends as `search_auth_failed`. Session calls never go through the retry loop, and a login Bluesky rejects latches for the life of the process — credentials cannot change without a restart, and each attempt spends a login. A login or refresh answered 429 sets a second, temporary latch: until the response's `ratelimit-reset` epoch time (15 minutes when it carries none) every search fails as `search_login_limited` without sending anything, and a session a limited refresh interrupted is kept, so it is refreshed rather than replaced once the limit lifts. A failed login or refresh is handed to every search waiting on it, so its error carries no single request's identity. The session lives in `search-session.ts`, behind one `run(ctx, send)` call, so the service holds no token.
- *Gate:* without credentials the tool is wrapped in `disabledTool()`, so it is absent from `tools/list` and shown only on the landing page with the enable hint. Chosen over registering it with a typed "requires auth" error: keyless search failed 24 of 25 probes, so an advertised tool would cost every agent a wasted call. The server instructions are built from the same switch, and no other tool's description, describe, or recovery hint names search — they name `bsky_get_feed` and `bsky_get_author_feed` as AT-URI sources — so the text is correct under either configuration.
- *Shared account:* on a hosted instance every caller searches as the operator's account. The AppView drops posts from accounts in a block relationship with it in either direction and applies no mutes; the tool description and README say so and recommend a dedicated account with a standard app password. The AppView also hydrates `viewer` state for that account on every post and author; normalization maps none of it, and a test pins that.
- *Errors:* `search_auth_failed` (Unauthorized), `search_login_limited` (RateLimited, naming when searching resumes), and `search_refused` (Forbidden), all recovering to `bsky_get_trending` → `bsky_get_feed`, which work without credentials. Tokens and credentials live in memory only; session lifecycle logs go to the server-side logger, never `ctx.log`, which reaches clients.

**22. `bsky_get_feed` reads a feed by AT-URI or bsky.app URL, unauthenticated, and does not retry a feed generator's failure.**
- *Input:* the generator's AT-URI or its bsky.app page, validated by one pattern in `at-syntax.ts` that `getTrends` also uses to parse a trend's `link`. Any other collection is rejected locally — the AppView answers a post AT-URI with the same `could not find feed` as a missing feed, and an AT-URI with no record key with a 500.
- *Handle owners:* `getFeed` finds a feed only by its owner's DID (`at://bsky.app/…/whats-hot` answers 400 while the DID form answers 200), and Discover's share URL uses the handle. A handle costs one keyless `resolveHandle`; a DID costs nothing extra.
- *Pins:* feed generators return `app.bsky.feed.defs#reasonPin` items (a bare `$type`), which normalized as ordinary items and read as the newest post. They now carry `pinned: true` and render a pin line; a pin is never a repost.
- *Truncation:* disclosed on a non-empty cursor, not on count — trend feeds answer 29 of 30 with more behind them, and a personalized feed answered one item with `cursor: ""`, which is treated as no cursor.
- *Errors:* keyed on the XRPC message, since the AppView reports these as `InvalidRequest` rather than the lexicon's `UnknownFeed`: `feed_not_found` (`could not find feed`, `Unable to resolve handle`), `feed_unavailable` (`could not resolve identity`, `feed unavailable`, `Upstream server responded with …`), `feed_requires_login` (401 `AuthRequiredError`). A failure mapped onto a declared reason is final — the retry loop leaves it alone — because a generator that is down was measured at ~6 s per 502, so four attempts would keep the caller waiting half a minute for the same answer.
- *No auth, ever:* through the search session a personalized feed would personalize to that one account for every caller, and the AppView refuses entryway-issued tokens for `getFeed` anyway.

**23. A trend is a feed, so its drill-down is `bsky_get_feed`.**
`getTrends` returns `topic` as the 12-hex record key of a feed generator owned by `trending.bsky.app`, and `link` as that feed's bsky.app page; every trend sampled (25 of 25) had that shape, and every derived feed answered `getFeed` keyless. A hex key matches nothing as a search query. Each trend therefore carries `feedUri`, parsed from `link` — never assembled from `topic`, so a trend whose `link` is missing or is not a feed page carries none — and the tool description and server instructions route drill-down there. `description`, Bluesky's one-sentence summary of the story, was dropped in normalization and now reaches both channels, quoted like other third-party text.

**24. `truncated` means a further request would return more — and on the list endpoints, only that a cursor came back.**
- *Trending:* `getTrends` has no cursor or total, and at `limit: N` serves the first N of the `limit: 25` list (12 of 12 back-to-back pairs on 2026-09-25). The handler asks for `min(limit + 1, 25)` and returns the first `limit`, so the extra topic is an exact sentinel: `truncated` is set only when it came back. Keying on `trends.length >= limit` fired at 25, where raising the limit is impossible (26 answers HTTP 400), and whenever the pool was exactly `limit`.
- *Follow graph and actor search:* the cursor is the only continuation signal these endpoints expose, and page size is not one — searchActors pages at `limit: 100` carry cursors at 68–100 actors, and the follow graph pages over follow records, dropping accounts that no longer resolve, so a cursor can lead to an empty page. `truncated` is therefore keyed on the cursor, whatever the page held, and the follow graph's describe says a cursor is not proof more accounts exist. An empty page reached through a cursor, with none handed back, reports that the previous page was the last instead of the no-match notice. `limit + 1` was rejected here: at `limit: 10` the graph returned 9 actors and a cursor, so an extra slot proves nothing.

**25. Actor lists carry no counts; `bsky_get_profile` does.**
`searchActors`, `getFollowers`, and `getFollows` return `app.bsky.actor.defs#profileView` for every actor and for the graph `subject`, and that view has no `followersCount` or `followsCount` — only `profileViewDetailed` (`getProfile`) does. The fields had been declared on both tools since the first implementation and were never populated. They are dropped rather than hydrated through `getProfiles` (25 actors per call): hydration would turn every call into 2–6 upstream requests against an AppView with undocumented rate limits, and add a second failure point that either fails a listing that succeeded or drops its counts without saying so.

---

## Known Limitations

- **`searchPosts` result freshness**: The AppView indexes with some lag (seconds to minutes). Real-time posts may not appear immediately.
- **`getPostThread` per-post reply limit**: The AppView returns only part of a post's replies and offers no way to fetch the rest. A 1,805-reply thread returns ~163 top-level replies, invariant across `depth` 1–1000, and no node in a 748-thread walk ever returned more than 200; `app.bsky.feed.getPostThread` has no cursor on `replies`, and the unstable `app.bsky.unspecced.getPostThreadV2` / `getPostThreadOtherV2` pair returns *fewer* replies for the same thread while reporting `hasOtherReplies: false`. The server therefore discloses the shortfall rather than working around it — see design decision 13.
- **`replyCount` counts more than the thread can return**: Bluesky's per-post reply counter is not reduced when a reply leaves the index, so a post routinely reports replies that no request can produce — 1,244 nodes in a 748-thread walk reported `replyCount: 1` beside an empty `replies` array. `unreturnedReplies` and the thread-wide total are therefore upper bounds on what is missing, not counts of readable replies.
- **`getPostThread` reply-tree depth**: The AppView returns at most 10 levels of replies however large `depth` is. Nodes at that edge carry `truncationReason: "depth"`; fetching such a node's AT-URI as its own thread continues below it.
- **Parent chains longer than `parent_height` are cut, and the cut is disclosed rather than fixed**: The AppView stops the chain at the requested height and gives no signal that it did, so the server derives one — the topmost returned parent carries `parentChainTruncated: true` when it still has a `replyToUri`. Reading above it takes a second request rooted at that node; the server does not chain them itself, since a 645-post ancestry would be seven round trips and a megabyte of posts nobody asked for.
- **`bsky_search_actors` and `bsky_get_follows` carry no counts and no `website`**: they read `app.bsky.actor.defs#profileView`, which declares `pronouns` — carried on both, including `getFollows`' `subject` — but not `followersCount`, `followsCount`, `postsCount`, or `website`. Only `profileViewDetailed`, behind `bsky_get_profile` and the profile resource, carries them. Resolve an account with `bsky_get_profile` when they matter (decision 25).
- **A follow-graph cursor can lead to an empty page**: the graph pages over follow records and drops accounts that no longer resolve, so a page can come back short of `limit` with a cursor, and that cursor can return nothing (decision 24).
- **Social graph scale**: Accounts with millions of followers return only the first page (`limit` ≤ 100 per call). Pagination via cursor is the only path to the full set.
- **No full-text search history**: `searchPosts` covers roughly the last 30 days of indexed content; older posts are not searchable.
- **Unauthenticated rate limits**: The public AppView has undocumented rate limits. The service layer retries up to 3 times with backoff from a 500ms base; sustained high-volume use may hit limits.
- **Post search needs an account, and sees what that account sees**: Without `BLUESKY_IDENTIFIER` / `BLUESKY_APP_PASSWORD` the tool is not offered (decision 21). With them, results exclude posts from accounts in a block relationship with the configured account, and that omission looks the same as no match. Logins are limited to about 10 a day per account.
- **Personalized feeds cannot be read**: A feed that personalizes to its reader answers 401 (or, for some, a 502 from its generator) without a signed-in account, and `bsky_get_feed` never authenticates (decision 22).
- **No repost filter on `bsky_get_author_feed`**: `app.bsky.feed.getAuthorFeed` has no parameter that excludes reposts, and every `filter` value includes them. Filtering server-side would break the `limit` contract (ask for 25, get back however many survive), so reposts are marked with `repostedBy`/`repostedAt` and left in place for the caller to skip.
- **`bsky_get_trending` uses an `unspecced` endpoint**: `app.bsky.unspecced.getTrends` is not part of Bluesky's stable lexicon and may change or be removed without notice. Confirmed live as of 2026-06-04.
- **`hitsTotal` cannot exceed 10,000**: The AppView caps the count. A query whose real corpus is millions of posts reports exactly 10,000, so the value is a floor and the tool presents it as one rather than adding a machine-readable field for a number that cannot be measured.
- **A well-formed language tag naming no indexed language filters nothing**: The AppView accepts any BCP-47-shaped value and drops the filter for one it does not recognize (`lang=qqq` returns 200 with unfiltered results). Local validation checks shape only — matching the API — so this case is documented in the field description rather than rejected.
- **Grandfathered and private-use language tags are rejected locally**: The shape pattern requires a two- or three-letter primary subtag, so irregular tags such as `i-klingon` and private-use `x-…` tags fail validation even though the AppView answers them with 200. Both are deprecated forms, and the AppView drops their filter rather than applying it — `lang=i-klingon` and `lang=x-pig-latin` each return the same unfiltered mix a bare query does — so the practical loss is nil; use the modern replacement (`tlh` for Klingon), which the pattern accepts. Extended forms with a regular primary subtag are unaffected: `en-US-x-private`, `en-GB-oed`, `zh-Hant-TW`, and three-letter codes such as `fil` all pass.

---

## API Reference

**Endpoint base:** `https://api.bsky.app/xrpc/`

**Confirmed response shapes (live probe 2026-06-04):**

`getProfile` → `{ did, handle, displayName, description, pronouns?, website?, avatar, banner, followersCount, followsCount, postsCount, labels, indexedAt, createdAt, associated, verification, status?, pinnedPost? }` — `pronouns` and `website` are declared on `app.bsky.actor.defs#profileViewDetailed` and returned live for accounts that set them (`nerdynanny.com` carries both). `pronouns` is also declared on `profileView` and `profileViewBasic` and comes back on `searchActors`; `website` is on `profileViewDetailed` alone. `banner` and `status` are returned but not mapped.

`searchActors` → `{ actors: [{ did, handle, displayName, description, avatar, labels, createdAt, indexedAt, associated, verification }], cursor? }`

`getAuthorFeed` → `{ feed: [{ post: { uri, cid, author, record, bookmarkCount, replyCount, repostCount, likeCount, quoteCount, indexedAt, labels, embed? }, reply? }], cursor? }`

`getPostThread` → `{ thread: { post, replies: [...], parent? }, threadgate? }` — nested. The `thread`, `parent`, and `replies` slots are the same three-member union: `app.bsky.feed.defs#threadViewPost` (carries `post`), `#notFoundPost` (`{ uri, notFound: true }`, deleted or never existed), and `#blockedPost` (`{ uri, blocked: true, author: { did } }`). There is no member for truncated subtrees — a shortfall is only visible by comparing a node's `post.replyCount` against the replies it carries. Parent-chain nodes never carry a `replies` key. `threadgate` is `app.bsky.feed.defs#threadgateView`: `{ uri, cid, record: { allow?, hiddenReplies? }, lists }`, where `allow` is a union of `app.bsky.feed.threadgate#mentionRule` / `#followingRule` / `#followerRule` / `#listRule`.

`getFollowers` / `getFollows` → `{ followers|follows: [...profileViews], subject: profileView, cursor? }` — `app.bsky.actor.defs#profileView` on both, with no follower, following, or post counts. The cursor can come back on a short page and lead to an empty one (decision 24).

`searchPosts` → `{ posts: [...postViews], cursor?, hitsTotal? }` — same `postView` shape as feed entries. `hitsTotal` is present on every response, including zero-result ones, and saturates at 10,000: broad queries ("a", "the", "bluesky", "cat") all report exactly that, while narrow ones report a real count. Unauthenticated, the request itself now answers 403 (decision 21); authenticated through the account's PDS, the returned cursor fetches a second page with no overlap. The tool reports exactly 10,000 as a lower bound in both the field description and the rendered header, and any smaller value as the exact count it is. A cursor comes back on every non-empty response whether or not the set was exhausted (`q=cyanheads&limit=100` → 23 posts, `hitsTotal` 23, cursor present; `q=mcp-ts-core&limit=100` → 3, 3, cursor present), so truncation is disclosed on `hitsTotal > posts.length` and falls back to the cursor only if `hitsTotal` is absent. Neither signal alone is sound: `hitsTotal` is present on every response including empty ones, and the cursor is present on every non-empty one.

**`lang` validation:** the AppView checks BCP-47 *shape*, not a language registry. `en`, `ja`, `en-US`, `pt-BR`, and `zh-Hant` are accepted and filtered; `qqq` and `aaa` are accepted, then the filter is silently dropped and results come back unfiltered; `english`, `zzzz`, and `e n` are rejected with `InvalidRequest: Invalid language (got "…")`. The input schema therefore validates shape only — a registry check here would be stricter than the API it wraps.

`getTrends` → `{ trends: [{ topic, displayName, description, link, startedAt, postCount, status, category, actors: [...actorProfiles] }] }` — `topic` is a 12-hex feed-generator record key and `link` the relative `/profile/<did>/feed/<topic>` page of that feed (25 of 25 on 2026-09-25, all owned by `trending.bsky.app`); `status` observed values: `hot`, `cooling`, `stale`; `category` observed values: `politics`, `sports`, `pop-culture`. No cursor and no total — returns the current snapshot up to `limit`, whose lexicon `maximum` is 25; `limit: 26` answers HTTP 400 `integer too big (maximum 25, got 26)`. `limit: N` returns the first N topics of the `limit: 25` list (decision 24).

`getFeed` → `{ feed: [{ post, reason?, reply?, feedContext? }], cursor? }` — `reason` is `app.bsky.feed.defs#reasonRepost` (`by`, `indexedAt`) or `#reasonPin` (a bare `$type`). `cursor` may be `""`, and a page may hold fewer than `limit` items with a cursor. Keyless on `api.bsky.app`; requires a DID authority.

`com.atproto.identity.resolveHandle` → `{ did }`; an unknown handle answers 400 `Unable to resolve handle`.

`com.atproto.server.createSession` (at `https://bsky.social`) / `refreshSession` (at the PDS, refresh token as bearer) → `{ accessJwt, refreshJwt, did, handle, didDoc, … }` — the DID document's `#atproto_pds` service names the PDS; access tokens live 2 h, refresh tokens 90 d and rotate on every refresh. `createSession` carried `ratelimit-policy: 10;w=86400` on 2026-09-25.

**Error shape:** `{ "error": "InvalidRequest" | "AuthMissing" | ..., "message": "..." }` — an edge-level 403 answers with an HTML page instead, which the service drops from error data.

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
- `invalid_at_uri` — `ValidationError` — the `uri` passed the input pattern but the AppView could not resolve its authority, collection, or record key (API returns `InvalidRequest: Invalid at-uri`). A URI that fails the pattern outright never reaches the handler — it fails schema validation first. Recovery: copy the AT-URI unchanged from the `uri` field of a post returned by `bsky_get_feed` or `bsky_get_author_feed`.
- `uri_is_feed` — `ValidationError` — the AT-URI names a feed generator (`app.bsky.feed.generator`), which the AppView would answer as a missing post. Rejected before any request. Recovery: read it with `bsky_get_feed`.
- `post_not_found` — `NotFound` — Post AT-URI is valid format but the post was deleted or never existed. Recovery: verify the AT-URI, or re-read the author's recent posts with `bsky_get_author_feed`. Neither recovery names post search, which may not be registered (decision 21).

**`bsky_get_feed`** (all thrown by the service)
- `feed_not_found` — `NotFound` — no generator at that address (`could not find feed`), or the handle in it does not resolve (`Unable to resolve handle`). Recovery: check the address, or take a working `feedUri` from `bsky_get_trending`.
- `feed_unavailable` — `ServiceUnavailable`, retryable — the generator did not answer (`could not resolve identity: did:web:…`, 502 `feed unavailable`, `Upstream server responded with a … error`). Not retried in-process (decision 22). Recovery: try later, or read a different feed.
- `feed_requires_login` — `Unauthorized` — a personalized feed (401 `AuthRequiredError`). Recovery: read a public feed instead.

**`bsky_get_follows`**
- `actor_not_found` — `NotFound` — Actor handle or DID does not exist. Recovery: verify the actor or use `bsky_search_actors` to confirm the handle.

**`bsky_search_posts`**
- `upstream_rejected_filter` — `ValidationError` — the AppView answered `InvalidRequest` naming a parameter it could not parse. The framework captures the upstream body on every non-2xx response but surfaces it only as opaque error data, so without this the caller sees `Status: 400` with nothing to act on. The handler pulls Bluesky's own `message` out of that body and carries it as the failure message and the `recovery.hint`. Recovery: read Bluesky's quoted message for the parameter it named, correct that value, and call again.
- `search_auth_failed` — `Unauthorized` — Bluesky rejected the configured login, or a session it issued could not be renewed. Thrown by the service. Recovery: the operator must fix the app password; meanwhile `bsky_get_trending` → `bsky_get_feed`.
- `search_login_limited` — `RateLimited` — a login or refresh was answered 429: the account's daily login limit is used up. Thrown by the service, without a request, until the `ratelimit-reset` time (15 minutes when absent); message and `retryAt` name that time. Recovery: search again after it; meanwhile `bsky_get_trending` → `bsky_get_feed`.
- `search_refused` — `Forbidden` — Bluesky refused the search request itself; the edge's HTML page never reaches the error. Thrown by the service. Recovery: `bsky_get_trending` → `bsky_get_feed`.

**`bsky_search_actors`**, **`bsky_get_trending`**
- No domain-specific error contracts beyond baseline (`ServiceUnavailable` for upstream failures, `ValidationError` for invalid param values). These endpoints return empty results rather than errors for zero-match queries.

---
name: bluesky-mcp-server
description: "Bluesky / AT Protocol social data — search posts, read profiles, threads, and author feeds across the open social network; no key for public reads."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/bluesky-mcp-server"
created: 2026-05-30
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
pattern: deep single-source
complexity: medium
api-deps: Bluesky AT Protocol AppView (public.api.bsky.app) — public XRPC reads; optional authenticated posting
api-cost: free (public reads via public.api.bsky.app, no key; authenticated posting via app password / OAuth for single-user)
hostable: true
composes-with: gdelt-mcp-server, hn-mcp-server, wikidata-mcp-server
---

# bluesky-mcp-server

Social data from Bluesky and the AT Protocol — full-text post search, profiles, threads, author feeds, and the social graph, served by the public AppView (`public.api.bsky.app`) with **no authentication for public reads**. An optional authenticated mode adds single-user posting.

The fleet has `hn` (Hacker News, tech community) and `gdelt` (global news media), but **no general social-discourse source**. Bluesky fills it — real-time public conversation on an open protocol, which is the on-brand fit (Casey's brand is open-protocol infrastructure). The read surface is genuinely hostable (keyless, multi-user, no per-user secrets), unlike most social APIs that gate reads behind OAuth.

**Audience:** Social listening and trend analysis, journalists and researchers tracking discourse, sentiment workflows, anyone wanting "what is Bluesky saying about X" — plus single users who want an agent to post on their behalf.

## User Goals

- Search public posts by keyword, with filters (author, language, time, tag)
- Look up a profile (followers, posts, bio) by handle or DID
- Read a full conversation thread from a post
- Get a user's recent posts (author feed)
- Find accounts by name
- (Optional, authenticated) Publish a post or reply as a single signed-in user

## API Surface

AT Protocol XRPC methods via the public AppView — keyless for `app.bsky.*` reads. Identifiers come in three forms: **handle** (`bsky.app`), **DID** (`did:plc:…`, the stable identity), and **AT-URI** (`at://did/app.bsky.feed.post/rkey`, addresses a specific record). Writes go through an authenticated session (`com.atproto.repo.createRecord`).

| XRPC method | Purpose | Auth |
|:------------|:--------|:-----|
| `app.bsky.actor.getProfile` | Profile by handle/DID | none |
| `app.bsky.feed.searchPosts` | Full-text post search + filters | none |
| `app.bsky.feed.getAuthorFeed` | A user's recent posts | none |
| `app.bsky.feed.getPostThread` | Full reply tree for a post (AT-URI) | none |
| `app.bsky.actor.searchActors` | Find accounts by query | none |
| `app.bsky.graph.getFollowers` / `getFollows` | Social graph edges | none |
| `app.bsky.feed.getFeed` | A custom algorithmic feed | none |
| `com.atproto.repo.createRecord` | Create a post/reply/like | session (app password / OAuth) |

Public reads hit `public.api.bsky.app` (no token). Posting requires a session against the user's PDS — an app password or OAuth flow — and is inherently **single-user**, so it stays out of the hosted multi-tenant surface.

## Tool Surface (sketch)

```
bsky_search_posts    — full-text search across public posts. Query + filters:
                       author (handle/DID), mentions, language, domain, since/until,
                       tag, sort (top | latest). Returns posts with text, author
                       profile, like/repost/reply counts, embeds (images/links/
                       quoted posts), AT-URI, and timestamp. The headline tool —
                       real-time social discourse on any topic.

bsky_get_profile     — actor profile by handle or DID. Returns displayName, handle,
                       DID, description, follower/following/post counts, avatar,
                       labels (moderation), and verification status. Resolves the
                       handle↔DID mapping other tools need.

bsky_get_author_feed — a user's recent posts by handle/DID. Filter:
                       posts_with_replies | posts_no_replies | posts_with_media.
                       Returns an ordered post list with engagement and embeds.
                       "What has this account been posting?"

bsky_get_post_thread — full conversation for a post (AT-URI). Returns the root,
                       parent chain, and nested reply tree with per-post author and
                       engagement. "Read the whole conversation," not just the
                       single post.

bsky_search_actors   — find accounts by name/handle query. Returns ranked profiles
                       (handle, DID, displayName, description, follower count).
                       Disambiguation step before profile/feed lookups.

bsky_list_follows    — social graph edges for an account (handle/DID). Direction
                       param: followers | following. Returns paginated profiles
                       (handle, DID, displayName, description, follower count).
                       Covers app.bsky.graph.getFollowers and getFollows — the
                       documented API methods missing from the original tool surface.

bsky_create_post     — OPTIONAL, authenticated single-user. Publish a post or reply
                       as the signed-in account (app password / OAuth). Supports
                       text, reply-to (AT-URI), and basic embeds. Elicit-guarded
                       before publish; destructiveHint fallback. Excluded from the
                       hosted read-only surface — local single-user mode only,
                       mirroring linkedin-mcp-server's posting boundary.
```

## Design Notes

- Medium complexity, almost entirely from **AT Protocol concepts**, not endpoint count. The server must teach (in descriptions) the handle vs. DID vs. AT-URI distinction and resolve between them transparently — agents will have a handle and need a DID, or a post and need its AT-URI.
- **Two-tier auth by design.** The hosted server is the keyless public read/search surface (`public.api.bsky.app`) — that's the fleet value and what `hostable: true` refers to. Posting is a separate, optional, single-user mode (app password or OAuth against the user's PDS), gated like `linkedin`. Keep them cleanly separated so the hosted deployment never needs a credential.
- `bsky_search_posts` is the standout — most other social platforms have locked down search; Bluesky's is open and keyless. Lean into its filters (author, lang, tag, time, top-vs-latest).
- **Moderation labels** ride on profiles and posts. Surface them rather than silently filtering — the agent should know a label exists, but the server shouldn't editorialize.
- Embeds matter: posts carry images, external link cards, and quoted posts. Reshape embeds into a clean structure (type + key fields + media URLs) so the LLM sees the full content, not just `text`.
- Rate limits on the public AppView are reasonable but unauthenticated; the service layer should backoff politely and identify itself.
- Composes with `gdelt` (compare social discourse against news-media coverage of the same event), `hn` (tech-community sentiment cross-check), `wikidata` (resolve a person/org mentioned in posts to structured facts).
- Moonshot: a firehose/Jetstream-backed "live topic monitor" tool that samples the real-time stream for a keyword — turns the server from request/response into a streaming social sensor.
- README one-liner: "Search and read the open social web — posts, profiles, and threads on Bluesky / AT Protocol, no key for public reads."

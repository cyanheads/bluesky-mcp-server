---
name: bluesky-guide
description: Use bsky_* tools for topic research, account attribution, list or starter-pack research, and reactions to a post. Choose the evidence set, follow identifiers across calls, and qualify conclusions when pagination or conversation coverage is incomplete.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use these workflows to investigate public Bluesky discussion. The tools read posts and accounts; they do not publish replies or posts. Most reads need no credentials. Full-text post search depends on the deployment's configured account; check whether `bsky_search_posts` is available before planning around it.

## Identifiers

Carry identifiers returned by the preceding call into the next one:

- `bsky_search_actors` yields candidate handles and DIDs. Inspect the selected account with `bsky_get_profile` before attributing statements to a person known only by name.
- `bsky_get_trending` and `bsky_search_feeds` yield `feedUri` values for `bsky_get_feed`.
- `bsky_get_list` discovers an account's lists or starter packs and opens their returned record URIs. A starter pack has its own URI and a separate backing-list URI; use the list URI with `bsky_get_feed`, or follow one of the pack's feed-generator references.
- Returned posts carry their own `uri` for `bsky_get_post_thread`, `bsky_get_post_quotes`, and `bsky_get_post_interactions`. A profile's `pinnedPostUri` is another entry point into a conversation.

## Gates

1. Choose the evidence set before drawing a conclusion. A feed discovered by its name or description is a curated source of posts, not a substitute for searching all matching post text. Describe findings from that feed as findings from that feed.
2. Separate authorship from distribution. In an account's feed, inspect each post's author and repost attribution before saying the account wrote it. Treat a pinned post separately from recent activity.
3. Check continuation and coverage before claiming absence or completeness. Follow nonempty cursors with the same reference and collection, even after an empty page. A thread summary covers the returned conversation, with any remaining shortfalls stated.
4. Follow recoverable conversation boundaries; stop retrying a gap reported as unavailable. A reply-depth boundary can be continued by reading that boundary post as its own thread. A shortened parent chain can be continued upward. The topmost returned parent is not necessarily the conversation's first post.
5. Read replies and quote posts separately before summarizing reactions broadly. A reply thread alone does not cover the commentary in quote posts.

## Core chain

Start from the user's evidence: a name leads through actor discovery and a selected profile; a topic leads through available post search or feed discovery; a shared post leads directly into its conversation. Keep the returned post URI attached to each finding so a later call follows the same post rather than searching for its wording again.

## Workflows

**Topic research.** When available, use `bsky_search_posts` for matching post text and its structured filters. Without it, use `bsky_search_feeds` for a named topic or `bsky_get_trending` for current discussion, then read a returned feed with `bsky_get_feed`. Report which path supplied the evidence. Finding no suitable catalog feed does not establish that nobody posted about the topic.

**An account's statements.** Resolve the intended account, then read `bsky_get_author_feed`. Attribute original posts to their actual authors and describe reposts as reposts. When identity or verification matters, inspect `bsky_get_profile`; a discovery result is a candidate account, and the full profile carries verification issuances when available. Drill into a relevant post's conversation before summarizing a statement that depends on surrounding replies.

**A curated group.** Use `bsky_get_list` to discover the account's lists or starter packs, then open the chosen record. Page membership before claiming to have examined the group; an upstream member count is not the number of accounts on the current page. If a pack reports unavailable membership, describe that gap rather than calling the group empty. Read recent activity through `bsky_get_feed` using the backing list's URI, and treat the pack's recommended generators as separate feeds. Membership and recent posting activity answer different questions.

**Reactions to a post.** Read the target with `bsky_get_post_thread`, then use `bsky_get_post_quotes` for commentary that quotes it. Keep the target's statement separate from each reaction: quote results identify the target without repeating its text. Continue relevant reply branches and quote pages, and state which parts remain unread or unavailable rather than presenting the retrieved reactions as exhaustive.

**Who amplified a post.** Pass the post's URI to `bsky_get_post_interactions` with `kind: reposts` or `kind: likes`. Continue each list with its own cursor and the same post and kind. Account `createdAt` records when the account joined; `likedAt` records when it liked this post. Reposts carry no interaction timestamp. Inspect selected accounts with `bsky_get_profile` when attribution needs more context. Post counters can exceed retrievable interactions, so exhausted cursors do not establish that every counted account was examined; a like or repost alone does not explain the account's intent.

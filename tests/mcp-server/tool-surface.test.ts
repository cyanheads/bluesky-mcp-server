/**
 * @fileoverview Cross-tool surface audit: `bsky_search_posts` is gated off without credentials, so
 * no other definition may present it as callable — not in a description, a field describe, a
 * recovery hint, or a validation message — and the server instructions follow the same switch.
 * What `tools/list` itself offers under each configuration is asserted against the real entry
 * point in `tests/entrypoint.test.ts`.
 * @module tests/mcp-server/tool-surface.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { serverInstructions } from '@/mcp-server/server-surface.js';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { bskyGetPostQuotes } from '@/mcp-server/tools/definitions/bsky-get-post-quotes.tool.js';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { bskyGetProfile } from '@/mcp-server/tools/definitions/bsky-get-profile.tool.js';
import { bskyGetTrending } from '@/mcp-server/tools/definitions/bsky-get-trending.tool.js';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import {
  ACTOR_REF_MESSAGE,
  AT_URI_REF_MESSAGE,
  FEED_REF_MESSAGE,
  POST_URI_REF_MESSAGE,
} from '@/services/bluesky/at-syntax.js';

const ALWAYS_REGISTERED = [
  bskyGetProfile,
  bskySearchActors,
  bskyGetTrending,
  bskyGetFeed,
  bskyGetAuthorFeed,
  bskyGetPostThread,
  bskyGetPostQuotes,
  bskyGetFollows,
];

/** Every string a client can read off a definition before or after calling it. */
function surfaceText(def: (typeof ALWAYS_REGISTERED)[number]): string {
  return JSON.stringify({
    description: def.description,
    input: z.toJSONSchema(def.input),
    output: z.toJSONSchema(def.output),
    errors: def.errors ?? [],
  });
}

describe('tools that stay registered without credentials', () => {
  it.each(ALWAYS_REGISTERED.map((def) => [def.name, def] as const))(
    '%s never names bsky_search_posts',
    (_name, def) => {
      expect(surfaceText(def)).not.toContain('bsky_search_posts');
    },
  );

  it('the identifier validation messages name only always-registered sources', () => {
    for (const message of [AT_URI_REF_MESSAGE, POST_URI_REF_MESSAGE]) {
      expect(message).not.toContain('bsky_search_posts');
      expect(message).toContain('bsky_get_author_feed');
    }
    expect(FEED_REF_MESSAGE).not.toContain('bsky_search_posts');
    expect(ACTOR_REF_MESSAGE).not.toContain('bsky_search_posts');
  });

  it('search recoveries route only to always-registered tools', () => {
    for (const reason of ['search_auth_failed', 'search_refused', 'search_login_limited']) {
      const recovery = bskySearchPosts.errors?.find((e) => e.reason === reason)?.recovery ?? '';
      expect(recovery).toContain('bsky_get_feed');
      expect(recovery).not.toContain('bsky_search_posts');
    }
  });
});

describe('the server instructions', () => {
  it('never name post search, or claim to need no account for it, when search is off', () => {
    const text = serverInstructions(false);
    expect(text).not.toContain('bsky_search_posts');
    expect(text).toContain('bsky_get_trending');
    expect(text).toContain('bsky_get_feed');
    expect(text).toMatch(/1\. bsky_get_trending/);
  });

  it('route quote reading to bsky_get_post_quotes and accept shared links, in either configuration', () => {
    for (const text of [serverInstructions(false), serverInstructions(true)]) {
      expect(text).toMatch(/\d\. bsky_get_post_quotes/);
      expect(text).toContain('bsky.app post or feed URL');
    }
  });

  it('lead with post search and disclose whose account it runs as when search is on', () => {
    const text = serverInstructions(true);
    expect(text).toMatch(/1\. bsky_search_posts — find posts on any topic, filtered by author/);
    expect(text).not.toContain('recent posts');
    expect(text).toContain('block relationship');
    expect(text).toContain('bsky_get_feed');
    expect(text).not.toMatch(/No authentication required/i);
  });
});

/** JSON Schema property names of an object schema, one level down a dotted path. */
function propertyNames(schema: z.ZodType, path: string[] = []): string[] {
  let node = z.toJSONSchema(schema) as { properties?: Record<string, unknown>; items?: unknown };
  for (const key of path) {
    const next = node.properties?.[key] as typeof node | undefined;
    node = (next?.items as typeof node | undefined) ?? next ?? {};
  }
  return Object.keys(node.properties ?? {});
}

describe('account counts live on the profile view only', () => {
  it('the actor-list tools declare no follower or following count, list entry or subject', () => {
    expect(propertyNames(bskySearchActors.output, ['actors'])).not.toContain('followersCount');
    expect(propertyNames(bskyGetFollows.output, ['actors'])).not.toContain('followersCount');
    expect(propertyNames(bskyGetFollows.output, ['subject'])).not.toContain('followersCount');
    expect(propertyNames(bskyGetFollows.output, ['subject'])).not.toContain('followsCount');
    for (const def of [bskySearchActors, bskyGetFollows]) {
      expect(surfaceText(def)).not.toMatch(
        /follower count|following count|followersCount|followsCount/i,
      );
    }
  });

  it('the actor-list tools send callers to bsky_get_profile for counts', () => {
    for (const def of [bskySearchActors, bskyGetFollows]) {
      expect(def.description).toMatch(/counts[^.]*bsky_get_profile|bsky_get_profile[^.]*counts/);
    }
  });

  it('bsky_get_profile keeps all three counts', () => {
    expect(propertyNames(bskyGetProfile.output)).toEqual(
      expect.arrayContaining(['followersCount', 'followsCount', 'postsCount']),
    );
  });
});

describe('bsky_search_actors pagination wording', () => {
  it('describes its cursor as ordinary pagination, never as 403-prone', () => {
    const text = surfaceText(bskySearchActors);
    expect(text).not.toMatch(/403|unreliable|refine the query/i);
    expect(bskySearchActors.input.shape.cursor.description).toMatch(/previous response/);
    expect(bskySearchActors.output.shape.cursor.description).toMatch(/absent on the last page/i);
  });
});

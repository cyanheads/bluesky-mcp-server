/**
 * @fileoverview bsky_get_author_feed through the real service over a faked global `fetch`: the
 * `filter` and `includePins` parameters as sent, and a profile's pinned post across pages — where it
 * sits, which item carries `pinned`, and that both surfaces say so. Any request no test routed
 * rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-get-author-feed.paging.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

const ACTOR = 'did:plc:z72i7hdynmk6r22z27h6tvur';

const post = (rkey: string, author = ACTOR) => ({
  uri: `at://${author}/app.bsky.feed.post/${rkey}`,
  cid: `bafy${rkey}`,
  author: { did: author, handle: author === ACTOR ? 'bsky.app' : 'other.bsky.social' },
  record: { text: `text ${rkey}` },
});

const PIN = { $type: 'app.bsky.feed.defs#reasonPin' };
const REPOST = {
  $type: 'app.bsky.feed.defs#reasonRepost',
  by: { did: ACTOR, handle: 'bsky.app' },
  indexedAt: '2026-09-18T00:00:00.000Z',
};

type FeedItem = { post: ReturnType<typeof post>; reason?: object };
type FeedPages = Record<string, { feed: FeedItem[]; cursor?: string }>;

function routeFeed(pages: FeedPages) {
  http.route({
    method: 'GET',
    match: /app\.bsky\.feed\.getAuthorFeed\?/,
    respond: (request: Request) => {
      const page = pages[new URL(request.url).searchParams.get('cursor') ?? ''];
      if (!page) return Response.json({ error: 'InternalServerError' }, { status: 500 });
      return Response.json(page);
    },
  });
}

type Structured = {
  posts: Array<{ uri: string; pinned?: boolean; repostedBy?: unknown }>;
  cursor?: string;
  originalPosts?: number;
  reposts?: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
};
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Structured;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');
const sentParams = (i: number) => new URL(http.calls[i]?.request.url ?? '').searchParams;

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});

afterEach(() => {
  http.restore();
});

describe('bsky_get_author_feed — parameters as sent', () => {
  it('sends no includePins by default, and the default filter', async () => {
    routeFeed({ '': { feed: [{ post: post('a') }] } });
    await runToolContract(bskyGetAuthorFeed, { actor: ACTOR });
    expect(sentParams(0).get('filter')).toBe('posts_no_replies');
    expect(sentParams(0).has('includePins')).toBe(false);
  });

  it('sends includePins=true when include_pins is set, and nothing when it is false', async () => {
    routeFeed({ '': { feed: [{ post: post('a') }] } });
    await runToolContract(bskyGetAuthorFeed, { actor: ACTOR, include_pins: true });
    await runToolContract(bskyGetAuthorFeed, { actor: ACTOR, include_pins: false });
    expect(sentParams(0).get('includePins')).toBe('true');
    expect(sentParams(1).has('includePins')).toBe(false);
  });

  it('forwards posts_with_video', async () => {
    routeFeed({ '': { feed: [] } });
    const result = await runToolContract(bskyGetAuthorFeed, {
      actor: ACTOR,
      filter: 'posts_with_video',
    });
    expect(result.isError).toBeFalsy();
    expect(sentParams(0).get('filter')).toBe('posts_with_video');
  });

  it('rejects a filter outside the enum at the schema, since Bluesky ignores one silently', () => {
    expect(() =>
      bskyGetAuthorFeed.input.parse({ actor: ACTOR, filter: 'posts_with_links' }),
    ).toThrow();
  });
});

describe('bsky_get_author_feed — a pinned post across pages', () => {
  /**
   * Page 1 at `limit` 3 comes back with 4 items — the pin arrives in addition to the limit — and
   * the pin sits past the first position, behind a repost, so nothing positional can mark it.
   * Page 2 holds no pin, and one of its items shares the pin's author, so nothing author-keyed
   * can mark it either.
   */
  const pages: FeedPages = {
    '': {
      feed: [
        { post: post('r1', 'did:plc:other'), reason: REPOST },
        { post: post('own1') },
        { post: post('pinned'), reason: PIN },
        { post: post('own2') },
      ],
      cursor: 'c2',
    },
    c2: { feed: [{ post: post('own3') }, { post: post('own4') }] },
  };

  it('page 1: exactly the pinned item carries pinned, on both surfaces, counted as the actor own post', async () => {
    routeFeed(pages);
    const result = await runToolContract(bskyGetAuthorFeed, {
      actor: ACTOR,
      include_pins: true,
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out.posts.map((p) => p.uri.split('/').at(-1))).toEqual(['r1', 'own1', 'pinned', 'own2']);
    expect(out.posts.map((p) => p.pinned ?? false)).toEqual([false, false, true, false]);
    expect(out.posts[2]).not.toHaveProperty('repostedBy');
    expect(out).toMatchObject({ originalPosts: 3, reposts: 1, truncated: true, shown: 4, cap: 3 });

    const blocks = textOf(result).split('\n\n---\n\n');
    expect(blocks[2]).toContain('📌 Pinned');
    expect(blocks[2]).toContain('/pinned`');
    expect(blocks.filter((b) => b.includes('📌'))).toHaveLength(1);
    expect(blocks[0]).toContain('Reposted by');
  });

  it('keeps the pin marker the service sets in structuredContent, not only in the rendered text', async () => {
    routeFeed({ '': { feed: [{ post: post('own1') }, { post: post('pinned'), reason: PIN }] } });
    const result = await runToolContract(bskyGetAuthorFeed, { actor: ACTOR });

    expect(result.isError).toBeFalsy();
    expect(structured(result).posts[1]).toMatchObject({ pinned: true });
    expect(textOf(result)).toContain('📌 Pinned');
  });

  it('page 2: no item carries pinned', async () => {
    routeFeed(pages);
    const result = await runToolContract(bskyGetAuthorFeed, {
      actor: ACTOR,
      include_pins: true,
      limit: 3,
      cursor: 'c2',
    });

    expect(sentParams(0).get('cursor')).toBe('c2');
    const out = structured(result);
    expect(out.posts.every((p) => !('pinned' in p))).toBe(true);
    expect(out).not.toHaveProperty('truncated');
    expect(textOf(result)).not.toContain('📌');
  });
});

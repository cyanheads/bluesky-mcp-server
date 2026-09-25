/**
 * @fileoverview The 48,000-byte response budget on the four paged post tools, through the real
 * service over a faked `fetch`. A page whose response would overflow either surface is asked for
 * again at `limit: k`, the number of posts that fit, and that second response is returned whole —
 * so its posts and its cursor come from one upstream answer. Asserts the `limit` values actually
 * sent, that the cursor after a cut resumes at the first post left out across a two-page walk,
 * that a re-requested page which still overflows is cut again with a smaller `k`, that the loop
 * is bounded, and that a single post larger than the budget still comes back alone.
 * @module tests/mcp-server/tools/response-budget.paged.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskyGetPostQuotes } from '@/mcp-server/tools/definitions/bsky-get-post-quotes.tool.js';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import {
  AUTHOR_DID,
  limitsSent,
  pageOf,
  postUri,
  rawPost,
  routeAuthorFeed,
  routeQuotes,
  routeRankedFeed,
  routeSearch,
  stream,
  surfaces,
  textOf,
} from './budget-fixtures.js';

const BUDGET = 48_000;

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
});

afterEach(() => {
  http.restore();
});

type Page = {
  posts: Array<{ uri: string; pinned?: boolean }>;
  cursor?: string;
  hitsTotal?: number;
  totalReturned?: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
  budgetCapped?: boolean;
  notice?: string;
};
const sc = (result: { structuredContent?: unknown }) => result.structuredContent as Page;
const rkeys = (page: Page) => page.posts.map((p) => p.uri.split('/').at(-1));

/** Both surfaces within the budget, and close to it — a cut that left room for another post is too deep. */
function expectFilled(result: Parameters<typeof surfaces>[0], postBytes: number) {
  const size = surfaces(result);
  expect(size.structured).toBeLessThanOrEqual(BUDGET);
  expect(size.content).toBeLessThanOrEqual(BUDGET);
  expect(Math.max(size.structured, size.content)).toBeGreaterThan(BUDGET - postBytes);
}

/** The budget disclosure reaches both surfaces, beside the cursor guidance it composes with. */
function expectDisclosed(
  result: Parameters<typeof textOf>[0] & { structuredContent?: unknown },
  guidance: string,
) {
  const page = sc(result);
  expect(page.budgetCapped).toBe(true);
  expect(page.notice).toContain(guidance);
  expect(page.notice).toContain('48,000');
  /** The limit the returned page was asked for — what a pinned post rides in addition to. */
  expect(page.notice).toContain(`limit ${page.posts.filter((p) => !p.pinned).length}`);
  expect(textOf(result)).toContain(`> ${page.notice}`);
  expect(textOf(result)).toContain('**budgetCapped:** true');
}

const MORE_POSTS = 'More posts exist — pass the returned cursor to fetch the next page.';

describe('bsky_get_author_feed — cut and re-requested', () => {
  const items = stream(150, 600);

  it('re-requests the overflowing page at the limit that fits and returns that response whole', async () => {
    routeAuthorFeed(http, items);
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', limit: 100 });

    expect(result.isError).toBeFalsy();
    const page = sc(result);
    const k = page.posts.length;
    expect(k).toBeGreaterThan(1);
    expect(k).toBeLessThan(100);
    expect(limitsSent(http, 'getAuthorFeed')).toEqual([100, k]);
    expect(rkeys(page)).toEqual(items.slice(0, k).map((p) => p.uri.split('/').at(-1)));
    expect(page.cursor).toBe(`c${k}`);
    expect(page).toMatchObject({ totalReturned: k, truncated: true, shown: k, cap: 100 });
    expectFilled(result, 1500);
    expectDisclosed(result, MORE_POSTS);
  });

  it('resumes at the first post left out: a two-page walk through cut pages equals the uncut sequence', async () => {
    routeAuthorFeed(http, items);
    const first = sc(await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', limit: 100 }));
    const second = sc(
      await runToolContract(bskyGetAuthorFeed, {
        actor: 'bsky.app',
        limit: 100,
        ...(first.cursor ? { cursor: first.cursor } : {}),
      }),
    );

    const walked = [...rkeys(first), ...rkeys(second)];
    expect(walked).toEqual(items.slice(0, walked.length).map((p) => p.uri.split('/').at(-1)));
    expect(second.budgetCapped).toBe(true);
    const k1 = first.posts.length;
    const k2 = second.posts.length;
    expect(limitsSent(http, 'getAuthorFeed')).toEqual([100, k1, 100, k2]);
    const cursors = http.calls.map((c) => new URL(c.request.url).searchParams.get('cursor'));
    expect(cursors).toEqual([null, null, `c${k1}`, `c${k1}`]);
    expect(second.cursor).toBe(`c${k1 + k2}`);
  });

  it('does not count the pinned post toward the limit it re-requests', async () => {
    routeAuthorFeed(http, items, rawPost(postUri('pinned'), { descriptionBytes: 600 }));
    const result = await runToolContract(bskyGetAuthorFeed, {
      actor: 'bsky.app',
      limit: 100,
      include_pins: true,
    });

    const page = sc(result);
    expect(page.posts[0]?.pinned).toBe(true);
    const k = page.posts.length - 1;
    expect(limitsSent(http, 'getAuthorFeed')).toEqual([100, k]);
    expect(rkeys(page).slice(1)).toEqual(items.slice(0, k).map((p) => p.uri.split('/').at(-1)));
    expectFilled(result, 1500);
  });

  it('keeps a single post larger than the budget, alone, re-requested at limit 1', async () => {
    const huge = [rawPost(postUri('huge'), { descriptionBytes: 60_000 }), ...items];
    routeAuthorFeed(http, huge);
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });

    const page = sc(result);
    expect(limitsSent(http, 'getAuthorFeed')).toEqual([25, 1]);
    expect(rkeys(page)).toEqual(['huge']);
    expect(page.cursor).toBe('c1');
    expect(page.budgetCapped).toBe(true);
    expect(surfaces(result).structured).toBeGreaterThan(BUDGET);
  });

  it('fails the call with the declared reason when the re-request fails, rather than returning the first page', async () => {
    let call = 0;
    http.route({
      method: 'GET',
      match: /app\.bsky\.feed\.getAuthorFeed\?/,
      respond: () =>
        call++ === 0
          ? Response.json({ feed: items.slice(0, 100).map((post) => ({ post })), cursor: 'c100' })
          : Response.json(
              { error: 'InvalidRequest', message: 'Profile not found' },
              { status: 400 },
            ),
    });
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', limit: 100 });

    expect(result.isError).toBe(true);
    expect(limitsSent(http, 'getAuthorFeed')).toHaveLength(2);
    const error = (result.structuredContent as { error: { data?: { reason?: string } } }).error;
    expect(error.data?.reason).toBe('actor_not_found');
  });

  /**
   * Bluesky answers a cursor it cannot decode with HTTP 500, so a 500 on a request carrying the
   * caller's cursor ordinarily fails as invalid_cursor. A re-request carries a cursor Bluesky just
   * accepted, so a 500 there is transient and is retried like any other.
   */
  it('retries a 500 on a re-request instead of blaming the cursor Bluesky just accepted', async () => {
    const serve = (request: Request) => {
      const { page, cursor } = pageOf(items, new URL(request.url));
      return Response.json({ feed: page.map((post) => ({ post })), ...(cursor ? { cursor } : {}) });
    };
    let call = 0;
    http.route({
      method: 'GET',
      match: /app\.bsky\.feed\.getAuthorFeed\?/,
      respond: (request: Request) =>
        call++ === 1
          ? Response.json(
              { error: 'InternalServerError', message: 'Internal Server Error' },
              { status: 500 },
            )
          : serve(request),
    });
    const result = await runToolContract(bskyGetAuthorFeed, {
      actor: 'bsky.app',
      limit: 100,
      cursor: 'c10',
    });

    expect(result.isError).toBeFalsy();
    const sent = limitsSent(http, 'getAuthorFeed');
    expect(sent).toHaveLength(3);
    expect(sent[1]).toBe(sent[2]);
    expect(sc(result).budgetCapped).toBe(true);
  });

  it('sends no second request when the caller asked for one post and it alone overflows', async () => {
    routeAuthorFeed(http, [rawPost(postUri('huge'), { descriptionBytes: 60_000 }), ...items]);
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', limit: 1 });

    expect(limitsSent(http, 'getAuthorFeed')).toEqual([1]);
    expect(sc(result)).not.toHaveProperty('budgetCapped');
  });

  it('measures content[] too — escaped text can make it the surface that binds', async () => {
    /** A `*` renders as `\*`, so these descriptions cost twice their JSON size in content[]. */
    const starry = stream(150, 600).map((p) => ({
      ...p,
      embed: { ...p.embed, external: { ...p.embed.external, description: '*'.repeat(1200) } },
    }));
    routeAuthorFeed(http, starry);
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', limit: 100 });

    const size = surfaces(result);
    expect(size.content).toBeLessThanOrEqual(BUDGET);
    expect(size.content).toBeGreaterThan(size.structured);
    expect(size.content).toBeGreaterThan(BUDGET - 4000);
    expect(sc(result).budgetCapped).toBe(true);
  });
});

describe('bsky_get_post_quotes — cut and re-requested', () => {
  it('re-requests on the DID-form uri the first response resolved, without resolving the handle again', async () => {
    const items = stream(150, 600);
    http.route({
      method: 'GET',
      match: /com\.atproto\.identity\.resolveHandle\?/,
      respond: Response.json({ did: AUTHOR_DID }),
    });
    routeQuotes(http, items);
    const result = await runToolContract(bskyGetPostQuotes, {
      uri: 'at://bsky.app/app.bsky.feed.post/quoted',
      limit: 100,
    });

    const page = sc(result);
    const k = page.posts.length;
    expect(limitsSent(http, 'getQuotes')).toEqual([100, k]);
    expect(http.calls.filter((c) => c.request.url.includes('resolveHandle'))).toHaveLength(1);
    const uris = http.calls
      .filter((c) => c.request.url.includes('getQuotes'))
      .map((c) => new URL(c.request.url).searchParams.get('uri'));
    expect(uris).toEqual([postUri('quoted'), postUri('quoted')]);
    expect(page.cursor).toBe(`c${k}`);
    expectFilled(result, 1500);
    expectDisclosed(result, 'More quotes exist — pass the returned cursor to fetch the next page.');
  });
});

describe('bsky_get_post_quotes — a 500 on the re-request', () => {
  it('is retried rather than reported as invalid_cursor, since Bluesky just accepted the cursor', async () => {
    const items = stream(150, 600);
    let call = 0;
    http.route({
      method: 'GET',
      match: /app\.bsky\.feed\.getQuotes\?/,
      respond: (request: Request) => {
        if (call++ === 1) {
          return Response.json(
            { error: 'InternalServerError', message: 'Internal Server Error' },
            { status: 500 },
          );
        }
        const url = new URL(request.url);
        const { page, cursor } = pageOf(items, url);
        return Response.json({
          uri: url.searchParams.get('uri'),
          posts: page,
          ...(cursor ? { cursor } : {}),
        });
      },
    });
    const result = await runToolContract(bskyGetPostQuotes, {
      uri: postUri('quoted'),
      limit: 100,
      cursor: 'c10',
    });

    expect(result.isError).toBeFalsy();
    expect(limitsSent(http, 'getQuotes')).toHaveLength(3);
    expect(sc(result).budgetCapped).toBe(true);
  });
});

describe('bsky_search_posts — cut and re-requested', () => {
  it('re-requests through the same session and keeps the second response’s hit count and cursor', async () => {
    routeSearch(http, stream(150, 600), 4321);
    const result = await runToolContract(bskySearchPosts, { query: 'weather', limit: 100 });

    const page = sc(result);
    const k = page.posts.length;
    expect(limitsSent(http, 'searchPosts')).toEqual([100, k]);
    expect(http.calls.filter((c) => c.request.url.includes('createSession'))).toHaveLength(1);
    expect(page).toMatchObject({ hitsTotal: 4321, cursor: `c${k}`, shown: k, cap: 100 });
    expectFilled(result, 1500);
    expectDisclosed(result, 'More posts match than were returned');
  });
});

describe('bsky_get_feed — a ranked feed that reranks on every request', () => {
  const FEED = `at://${AUTHOR_DID}/app.bsky.feed.generator/whats-hot`;
  const tagged = (call: number, count: number, bytes: number) =>
    Array.from({ length: count }, (_, i) =>
      rawPost(postUri(`call${call}-${i}`), { descriptionBytes: bytes }),
    );

  it('cuts again with a smaller k when the re-requested page still overflows, and returns the last page whole', async () => {
    routeRankedFeed(http, (call, limit) => ({
      posts: tagged(call, limit, call === 1 ? 1500 : 600),
      cursor: `cursor-${call}`,
    }));
    const result = await runToolContract(bskyGetFeed, { feed: FEED, limit: 100 });

    const page = sc(result);
    const [first, k1, k2, ...rest] = limitsSent(http, 'getFeed');
    expect(first).toBe(100);
    expect(k1).toBeLessThan(100);
    expect(k2).toBeLessThan(k1 ?? 0);
    expect(rest).toEqual([]);
    expect(page.posts).toHaveLength(k2 ?? -1);
    expect(page.posts.every((p) => p.uri.includes('/call2-'))).toBe(true);
    expect(page.cursor).toBe('cursor-2');
    /** k2 was predicted from the heavier second answer, so the lighter third one fits with room to spare. */
    expect(surfaces(result).structured).toBeLessThanOrEqual(BUDGET);
    expect(surfaces(result).content).toBeLessThanOrEqual(BUDGET);
    expectDisclosed(result, MORE_POSTS);
  });

  it('re-requests a handle-owned feed by the DID the first request resolved, looking the handle up once', async () => {
    http.route({
      method: 'GET',
      match: /com\.atproto\.identity\.resolveHandle\?/,
      respond: Response.json({ did: AUTHOR_DID }),
    });
    routeRankedFeed(http, (call, limit) => ({
      posts: tagged(call, limit, 600),
      cursor: `cursor-${call}`,
    }));
    const result = await runToolContract(bskyGetFeed, {
      feed: 'https://bsky.app/profile/bsky.app/feed/whats-hot',
      limit: 100,
    });

    expect(sc(result).budgetCapped).toBe(true);
    expect(http.calls.filter((c) => c.request.url.includes('resolveHandle'))).toHaveLength(1);
    const feeds = http.calls
      .filter((c) => c.request.url.includes('getFeed'))
      .map((c) => new URL(c.request.url).searchParams.get('feed'));
    expect(feeds).toEqual([FEED, FEED]);
  });

  /**
   * A feed may answer a re-request with fewer posts than it was asked for, and the notice names the
   * limit that was sent, not the count that came back — one more digit in "limit 40" than in
   * "limit 9". Swept across the byte boundary so one run of the sweep lands on it exactly: the page
   * returned must fit with the notice it actually carries.
   */
  it('measures the returned page with the limit its notice names, when a feed answers short', async () => {
    for (let pad = 0; pad < 40; pad++) {
      http.reset();
      /** Nine posts whatever the limit above nine — the first one's size walks the boundary. */
      routeRankedFeed(http, (call, limit) =>
        call === 0
          ? { posts: tagged(0, 100, 600), cursor: 'cursor-0' }
          : {
              posts: tagged(call, Math.min(9, limit), 4700).map((post, i) =>
                i === 0 ? rawPost(post.uri, { descriptionBytes: 2190 + pad }) : post,
              ),
              cursor: `cursor-${call}`,
            },
      );
      const result = await runToolContract(bskyGetFeed, { feed: FEED, limit: 100 });
      const size = surfaces(result);
      if (sc(result).posts.length > 1) {
        expect(size.structured).toBeLessThanOrEqual(BUDGET);
        expect(size.content).toBeLessThanOrEqual(BUDGET);
      }
    }
  });

  it('stops after three re-requests, the last at limit 1, however the feed keeps answering', async () => {
    /** Each answer is three times heavier than the last, so no prediction from the previous page holds. */
    routeRankedFeed(http, (call, limit) => ({
      posts: tagged(call, limit, 600 * 3 ** call),
      cursor: `cursor-${call}`,
    }));
    const result = await runToolContract(bskyGetFeed, { feed: FEED, limit: 100 });

    const sent = limitsSent(http, 'getFeed');
    expect(sent).toHaveLength(4);
    expect(sent[0]).toBe(100);
    expect(sent[2] ?? 0).toBeLessThan(sent[1] ?? 0);
    expect(sent[3]).toBe(1);
    const page = sc(result);
    expect(page.posts).toHaveLength(1);
    expect(page.posts[0]?.uri).toContain('/call3-');
    expect(page.budgetCapped).toBe(true);
  });
});

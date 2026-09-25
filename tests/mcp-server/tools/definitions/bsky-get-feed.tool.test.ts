/**
 * @fileoverview Tests for bsky_get_feed through the real service over a faked global `fetch`, so
 * handle resolution, the upstream error mapping, and the retry decision are the production code
 * paths. Any request no test routed rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-get-feed.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const APPVIEW = 'https://api.bsky.app/xrpc';
const BSKY_DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const WHATS_HOT = `at://${BSKY_DID}/app.bsky.feed.generator/whats-hot`;

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

const post = (rkey: string, extra: Record<string, unknown> = {}) => ({
  uri: `at://did:plc:author/app.bsky.feed.post/${rkey}`,
  cid: `bafy${rkey}`,
  author: { did: 'did:plc:author', handle: 'author.bsky.social', displayName: 'Author' },
  record: { text: `text of ${rkey}`, createdAt: '2026-09-25T07:00:00Z' },
  likeCount: 3,
  ...extra,
});

const xrpcError = (status: number, error: string, message: string) =>
  Response.json({ error, message }, { status });

type ErrorEnvelope = {
  code: number;
  message: string;
  data?: { reason?: string; recovery?: { hint?: string } } & Record<string, unknown>;
};
const errorOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: ErrorEnvelope }).error;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as {
    posts: Array<Record<string, unknown>>;
    cursor?: string;
    truncated?: boolean;
    shown?: number;
    cap?: number;
    notice?: string;
    totalReturned: number;
  };
const getFeedCalls = () =>
  http.calls.filter((c) => c.request.url.includes('app.bsky.feed.getFeed'));
const feedParam = (i = 0) => new URL(getFeedCalls()[i]?.request.url ?? '').searchParams.get('feed');

beforeEach(() => {
  http.reset();
  http.install();
  // Credentials configured on purpose: bsky_get_feed must stay unauthenticated regardless.
  initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
});

afterEach(() => {
  http.restore();
});

describe('bsky_get_feed — reading a feed', () => {
  it('reads a DID-authority feed with one request, unauthenticated, and discloses the next page', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({ feed: [{ post: post('a') }, { post: post('b') }], cursor: 'c2' }),
    });

    const result = await runToolContract(bskyGetFeed, { feed: WHATS_HOT, limit: 2 });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    const request = http.calls[0]?.request;
    expect(request?.url.startsWith(`${APPVIEW}/app.bsky.feed.getFeed?`)).toBe(true);
    expect(request?.headers.has('authorization')).toBe(false);
    expect(feedParam()).toBe(WHATS_HOT);
    expect(new URL(request?.url ?? '').searchParams.get('limit')).toBe('2');

    const out = structured(result);
    expect(out.posts.map((p) => p.uri)).toEqual([
      'at://did:plc:author/app.bsky.feed.post/a',
      'at://did:plc:author/app.bsky.feed.post/b',
    ]);
    expect(out).toMatchObject({
      cursor: 'c2',
      totalReturned: 2,
      truncated: true,
      shown: 2,
      cap: 2,
    });
    const text = textOf(result);
    expect(text).toContain('at://did:plc:author/app.bsky.feed.post/a');
    expect(text).toContain('> text of b');
    expect(text).toContain('c2');
  });

  it('discloses truncation on a non-empty cursor even when the page holds fewer than the limit', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({ feed: [{ post: post('a') }], cursor: 'more' }),
    });

    const out = structured(await runToolContract(bskyGetFeed, { feed: WHATS_HOT, limit: 30 }));
    expect(out).toMatchObject({ truncated: true, shown: 1, cap: 30 });
  });

  it('treats cursor "" as the end of the feed', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({ feed: [{ post: post('a') }], cursor: '' }),
    });

    const result = await runToolContract(bskyGetFeed, { feed: WHATS_HOT });
    const out = structured(result);
    expect(out).not.toHaveProperty('cursor');
    expect(out).not.toHaveProperty('truncated');
    expect(textOf(result)).not.toContain('cursor:');
  });

  it('forwards a cursor to the next page', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({ feed: [{ post: post('c') }] }),
    });

    await runToolContract(bskyGetFeed, { feed: WHATS_HOT, cursor: 'page-2' });
    expect(new URL(getFeedCalls()[0]?.request.url ?? '').searchParams.get('cursor')).toBe('page-2');
  });

  it('explains an empty feed on both surfaces', async () => {
    http.route({ match: /app\.bsky\.feed\.getFeed/, respond: Response.json({ feed: [] }) });

    const result = await runToolContract(bskyGetFeed, { feed: WHATS_HOT });
    expect(structured(result).posts).toEqual([]);
    expect(structured(result).notice).toContain('bsky_get_trending');
    expect(textOf(result)).toContain('The feed returned no posts');
  });

  it('marks a pinned item and a reposted item distinctly on both surfaces', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({
        feed: [
          { post: post('pin'), reason: { $type: 'app.bsky.feed.defs#reasonPin' } },
          {
            post: post('rp'),
            reason: {
              $type: 'app.bsky.feed.defs#reasonRepost',
              by: { did: 'did:plc:reposter', handle: 'reposter.bsky.social' },
              indexedAt: '2026-09-25T08:00:00Z',
            },
          },
          { post: post('plain') },
        ],
      }),
    });

    const result = await runToolContract(bskyGetFeed, { feed: WHATS_HOT });
    const [pin, repost, plain] = structured(result).posts;
    expect(pin).toMatchObject({ pinned: true });
    expect(pin).not.toHaveProperty('repostedBy');
    expect(repost).toMatchObject({
      repostedBy: { did: 'did:plc:reposter', handle: 'reposter.bsky.social' },
      repostedAt: '2026-09-25T08:00:00Z',
    });
    expect(repost).not.toHaveProperty('pinned');
    expect(plain).not.toHaveProperty('pinned');

    const blocks = textOf(result).split('\n\n---\n\n');
    expect(blocks[0]).toContain('📌 Pinned');
    expect(blocks[0]).not.toContain('Reposted');
    expect(blocks[1]).toContain('🔁 Reposted by @reposter.bsky.social');
    expect(blocks[1]).not.toContain('Pinned');
    expect(blocks[2]).not.toMatch(/Pinned|Reposted/);
  });

  it('keeps a sparse feed item valid and invents nothing for what upstream omitted', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({
        feed: [
          {
            post: {
              uri: 'at://did:plc:author/app.bsky.feed.post/s',
              cid: 'bafys',
              author: { did: 'did:plc:author', handle: 'author.bsky.social' },
              record: { text: '' },
            },
            feedContext: 'opaque',
          },
        ],
      }),
    });

    const result = await runToolContract(bskyGetFeed, { feed: WHATS_HOT });
    expect(result.isError).toBeFalsy();
    const [item] = structured(result).posts;
    expect(item).toEqual({
      uri: 'at://did:plc:author/app.bsky.feed.post/s',
      cid: 'bafys',
      text: '',
      author: { did: 'did:plc:author', handle: 'author.bsky.social' },
    });
    expect(textOf(result)).not.toMatch(/likes|Created:/);
  });
});

describe('bsky_get_feed — feed references', () => {
  it('resolves a handle authority to a DID before reading the feed', async () => {
    http.route(
      {
        match: `${APPVIEW}/com.atproto.identity.resolveHandle?handle=bsky.app`,
        respond: Response.json({ did: BSKY_DID }),
      },
      {
        match: /app\.bsky\.feed\.getFeed/,
        respond: Response.json({ feed: [{ post: post('a') }] }),
      },
    );

    const result = await runToolContract(bskyGetFeed, {
      feed: 'https://bsky.app/profile/bsky.app/feed/whats-hot',
    });

    expect(result.isError).toBeFalsy();
    expect(http.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
      '/xrpc/com.atproto.identity.resolveHandle',
      '/xrpc/app.bsky.feed.getFeed',
    ]);
    expect(feedParam()).toBe(WHATS_HOT);
  });

  it('reads a bsky.app URL with a DID owner without resolving anything', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({ feed: [{ post: post('a') }] }),
    });

    await runToolContract(bskyGetFeed, {
      feed: `https://bsky.app/profile/${BSKY_DID}/feed/whats-hot`,
    });
    expect(http.calls).toHaveLength(1);
    expect(feedParam()).toBe(WHATS_HOT);
  });

  it('accepts a trend feedUri as-is', async () => {
    const trendFeed = 'at://did:plc:qrz3lhbyuxbeilrc6nekdqme/app.bsky.feed.generator/1d558a3bc9ff';
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({ feed: [{ post: post('a') }] }),
    });

    await runToolContract(bskyGetFeed, { feed: trendFeed });
    expect(feedParam()).toBe(trendFeed);
  });

  it.each([
    ['a post AT-URI', `at://${BSKY_DID}/app.bsky.feed.post/3lc4gpsxr3c2q`],
    ['a list AT-URI', `at://${BSKY_DID}/app.bsky.graph.list/3lc4gpsxr3c2q`],
    ['an AT-URI with no record key', `at://${BSKY_DID}/app.bsky.feed.generator`],
    ['a bsky.app post URL', 'https://bsky.app/profile/bsky.app/post/3lc4gpsxr3c2q'],
    ['a bare record key', 'whats-hot'],
    ['a trailing slash', `${WHATS_HOT}/`],
  ])('rejects %s before any upstream call', async (_label, feed) => {
    const result = await runToolContract(bskyGetFeed, { feed });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(http.calls).toHaveLength(0);
  });

  it('points a post AT-URI at bsky_get_post_thread', async () => {
    const result = await runToolContract(bskyGetFeed, {
      feed: `at://${BSKY_DID}/app.bsky.feed.post/3lc4gpsxr3c2q`,
    });
    expect(textOf(result)).toContain('bsky_get_post_thread');
  });

  it.each([0, 101])('rejects limit %i at the schema', async (limit) => {
    const result = await runToolContract(bskyGetFeed, { feed: WHATS_HOT, limit });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });

  it('accepts limit 100 and defaults to 25', () => {
    expect(bskyGetFeed.input.parse({ feed: WHATS_HOT, limit: 100 }).limit).toBe(100);
    expect(bskyGetFeed.input.parse({ feed: WHATS_HOT }).limit).toBe(25);
  });
});

describe('bsky_get_feed — upstream failures', () => {
  /** Asserts the reason, its recovery hint on both surfaces, and that nothing was retried. */
  async function expectFailure(
    feed: string,
    reason: string,
    code: JsonRpcErrorCode,
    requests = 1,
  ): Promise<ErrorEnvelope> {
    const result = await runToolContract(bskyGetFeed, { feed });
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(code);
    expect(error.data?.reason).toBe(reason);
    const declared = bskyGetFeed.errors?.find((e) => e.reason === reason)?.recovery;
    expect(error.data?.recovery?.hint).toBe(declared);
    expect(textOf(result)).toContain(declared ?? '');
    expect(http.calls).toHaveLength(requests);
    return error;
  }

  it('maps an unresolvable handle to feed_not_found without reading the feed', async () => {
    http.route({
      match: /com\.atproto\.identity\.resolveHandle/,
      respond: xrpcError(400, 'InvalidRequest', 'Unable to resolve handle'),
    });

    const error = await expectFailure(
      'at://no-such-handle.bsky.social/app.bsky.feed.generator/x',
      'feed_not_found',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.message).toContain('no-such-handle.bsky.social');
    expect(getFeedCalls()).toHaveLength(0);
  });

  it('maps "could not find feed" to feed_not_found', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: xrpcError(400, 'InvalidRequest', 'could not find feed'),
    });
    await expectFailure(WHATS_HOT, 'feed_not_found', JsonRpcErrorCode.NotFound);
  });

  it.each([
    [400, 'InvalidRequest', 'could not resolve identity: did:web:dev-feed.ottr.sh'],
    [502, 'UpstreamFailure', 'feed unavailable'],
    [400, 'InvalidRequest', 'Upstream server responded with a 400 error'],
    [502, 'InternalServerError', 'Upstream server responded with a 500 error'],
  ])('maps %i %s "%s" to feed_unavailable, asking only once', async (status, name, message) => {
    http.route({ match: /app\.bsky\.feed\.getFeed/, respond: xrpcError(status, name, message) });
    const error = await expectFailure(
      WHATS_HOT,
      'feed_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
    );
    expect(error.message).toContain(message);
  });

  it('maps a personalized feed to feed_requires_login', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: xrpcError(
        401,
        'AuthRequiredError',
        "You have to be logged in for this feed because it's personalized",
      ),
    });
    await expectFailure(WHATS_HOT, 'feed_requires_login', JsonRpcErrorCode.Unauthorized);
  });

  it('still retries an AppView failure it cannot attribute to the feed generator', async () => {
    http.route(
      {
        match: /app\.bsky\.feed\.getFeed/,
        once: true,
        respond: xrpcError(503, 'ServiceUnavailable', 'overloaded'),
      },
      {
        match: /app\.bsky\.feed\.getFeed/,
        respond: Response.json({ feed: [{ post: post('a') }] }),
      },
    );

    const result = await runToolContract(bskyGetFeed, { feed: WHATS_HOT });
    expect(result.isError).toBeFalsy();
    expect(getFeedCalls()).toHaveLength(2);
  });
});

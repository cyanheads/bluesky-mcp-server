/**
 * @fileoverview Catalog discovery through the real public service and assembled tool contracts.
 * @module tests/mcp-server/tools/definitions/bsky-search-feeds.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serverTools } from '@/mcp-server/server-surface.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskySearchFeeds } from '@/mcp-server/tools/definitions/bsky-search-feeds.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const FEED = 'at://did:plc:jfhpnnst6flqway4eaeqzj2a/app.bsky.feed.generator/for-science';
const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'test-password' });
});

afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

const CATALOG = '/xrpc/app.bsky.unspecced.getPopularFeedGenerators';
const SCIENCE = {
  uri: FEED,
  displayName: 'Science',
  description:
    'The Science Feed. A curated feed from Bluesky professional scientists,  science communicators, and science/nature photographer/artists. See https://l.bossett.io/vkeNf for more information! 🧪',
  creator: {
    did: 'did:plc:jfhpnnst6flqway4eaeqzj2a',
    handle: 'bossett.social',
    displayName: 'Bossett',
  },
};
const NEXT =
  'eyJzIjpbOTEyLjY4NjksNDU3LDUuNjQ3MzcyZS04LCJkaWQ6cGxjOjZjMnpodmhud3M3em5rajVtZXVmaGZmZiIsImFhYWsyZnczZHgyZ3EiXX0';
const HISTORY = {
  uri: 'at://did:plc:lyrmsmhhg7vzz4ghj44y5xzq/app.bsky.feed.generator/6fbde5587ee4',
  displayName: 'History Science & Techno',
  description:
    'Tracking "#histsci", "#histtech", "history of science"\n\nhttps://track.goodfeeds.co/',
  creator: {
    did: 'did:plc:lyrmsmhhg7vzz4ghj44y5xzq',
    handle: 'track.goodfeeds.co',
    displayName: '',
  },
};
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? '').join('\n');
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as {
    feeds: Array<{
      feedUri: string;
      displayName: string;
      description?: string;
      creator: { did: string; handle: string; displayName?: string };
    }>;
    cursor?: string;
    truncated?: boolean;
    cap?: number;
    shown?: number;
    notice?: string;
    totalReturned: number;
  };
const errorOf = (result: { structuredContent?: unknown }) =>
  (
    result.structuredContent as {
      error: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
    }
  ).error;

function catalog(body: unknown, status = 200) {
  http.route({
    match: (request) => new URL(request.url).pathname === CATALOG,
    respond: () => Response.json(body, { status }),
  });
}

describe('bsky_search_feeds through public HTTP', () => {
  it('walks two pages in provider order and hands the returned feed URI directly to the reader', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname === CATALOG,
      respond: (request) =>
        Response.json(
          new URL(request.url).searchParams.has('cursor')
            ? { feeds: [HISTORY] }
            : { feeds: [SCIENCE], cursor: NEXT },
        ),
    });
    http.route({
      match: (request) => new URL(request.url).pathname === '/xrpc/app.bsky.feed.getFeed',
      respond: () =>
        Response.json({
          feed: [
            {
              post: {
                uri: 'at://did:plc:author/app.bsky.feed.post/science',
                cid: 'bafyscience',
                author: { did: 'did:plc:author', handle: 'scientist.bsky.social' },
                record: { text: 'Science post 🧪' },
              },
            },
          ],
        }),
    });
    const first = await runToolContract(bskySearchFeeds, { query: 'science', limit: 1 });
    expect(first.isError).toBeFalsy();
    expect(structured(first)).toEqual({
      feeds: [
        {
          feedUri: FEED,
          displayName: 'Science',
          description: SCIENCE.description,
          creator: SCIENCE.creator,
        },
      ],
      cursor: NEXT,
      totalReturned: 1,
      truncated: true,
      shown: 1,
      cap: 1,
      notice: 'Pass the returned cursor with the same query to fetch the next page of feeds.',
    });
    for (const value of [
      FEED,
      'Science',
      SCIENCE.description,
      SCIENCE.creator.did,
      'bossett.social',
      'Bossett',
      NEXT,
    ])
      expect(textOf(first)).toContain(value);
    expect(textOf(first)).toContain(structured(first).notice);
    expect(http.calls).toHaveLength(1);
    const second = await runToolContract(bskySearchFeeds, {
      query: 'science',
      limit: 1,
      cursor: structured(first).cursor,
    });
    expect(second.isError).toBeFalsy();
    expect(structured(second).feeds.map((feed) => feed.displayName)).toEqual([
      'History Science & Techno',
    ]);
    expect(structured(second).feeds[0]?.creator.displayName).toBe('');
    expect(textOf(second)).toContain('**Creator name:**');
    expect(structured(second)).not.toHaveProperty('cursor');
    expect(structured(second)).not.toHaveProperty('truncated');
    const read = await runToolContract(bskyGetFeed, {
      feed: structured(first).feeds[0]!.feedUri,
      limit: 2,
    });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ posts: [{ text: 'Science post 🧪' }] });
    expect(textOf(read)).toContain('Science post 🧪');
    expect(http.calls).toHaveLength(3);
    const requests = http.calls.map((call) => call.request);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      CATALOG,
      CATALOG,
      '/xrpc/app.bsky.feed.getFeed',
    ]);
    expect(
      requests.every(
        (request) =>
          new URL(request.url).origin === 'https://api.bsky.app' &&
          !request.headers.has('authorization') &&
          request.method === 'GET',
      ),
    ).toBe(true);
    expect(new URL(requests[0]!.url).searchParams.get('query')).toBe('science');
    expect(new URL(requests[1]!.url).searchParams.get('query')).toBe('science');
    expect(new URL(requests[1]!.url).searchParams.get('cursor')).toBe(NEXT);
    expect(new URL(requests[1]!.url).searchParams.get('limit')).toBe('1');
    expect(new URL(requests[2]!.url).searchParams.get('feed')).toBe(FEED);
  });

  it('preserves sparse optional fields and supplied blank strings without inventing values', async () => {
    catalog({
      feeds: [
        {
          uri: FEED,
          displayName: '',
          creator: { did: 'did:plc:sparse', handle: 'sparse.bsky.social' },
        },
        { ...SCIENCE, description: '', creator: { ...SCIENCE.creator, displayName: '' } },
      ],
    });
    const result = await runToolContract(bskySearchFeeds, { query: 'science' });
    expect(result.isError).toBeFalsy();
    expect(structured(result).feeds).toEqual([
      {
        feedUri: FEED,
        displayName: '',
        creator: { did: 'did:plc:sparse', handle: 'sparse.bsky.social' },
      },
      {
        feedUri: FEED,
        displayName: 'Science',
        description: '',
        creator: { ...SCIENCE.creator, displayName: '' },
      },
    ]);
    expect(textOf(result).split('**Description:**')).toHaveLength(2);
    expect(textOf(result).split('**Creator name:**')).toHaveLength(2);
    expect(textOf(result)).not.toMatch(/undefined|null|Unknown/);
    expect(new URL(http.calls[0]!.request.url).searchParams.get('limit')).toBe('25');
  });

  it.each([
    [undefined, 'No feeds matched this catalog query. Try broader feed names or descriptions.'],
    ['past-end', 'No more feeds in this catalog traversal.'],
  ])('distinguishes an empty page with input cursor %s', async (cursor, notice) => {
    catalog({ feeds: [] });
    const result = await runToolContract(bskySearchFeeds, {
      query: 'zzzznonexistentvalidation98376',
      ...(cursor ? { cursor } : {}),
    });
    expect(structured(result)).toEqual({ feeds: [], totalReturned: 0, notice });
    expect(textOf(result)).toContain('No feeds on this page.');
    expect(textOf(result)).toContain(notice);
    expect(http.calls).toHaveLength(1);
  });

  it('continues solely on a cursor, even on an empty page', async () => {
    catalog({ feeds: [], cursor: NEXT });
    const result = await runToolContract(bskySearchFeeds, { query: 'science', limit: 100 });
    expect(structured(result)).toMatchObject({
      feeds: [],
      cursor: NEXT,
      truncated: true,
      shown: 0,
      cap: 100,
    });
    expect(textOf(result)).toContain(NEXT);
    expect(textOf(result)).toContain(structured(result).notice);
    expect(textOf(result)).not.toContain('No feeds matched');
  });

  it.each([
    [
      'initial empty',
      [],
      undefined,
      'No feeds matched this catalog query. Try broader feed names or descriptions.',
    ],
    ['exhausted continuation', [], 'past-end', 'No more feeds in this catalog traversal.'],
    ['nonempty terminal', [SCIENCE], undefined, undefined],
  ] as const)(
    'treats an upstream empty cursor as terminal on a %s page',
    async (_label, feeds, cursor, notice) => {
      catalog({ feeds, cursor: '' });
      const result = await runToolContract(bskySearchFeeds, {
        query: 'science',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.isError).toBeFalsy();
      const output = structured(result);
      expect(output.totalReturned).toBe(feeds.length);
      expect(output).not.toHaveProperty('cursor');
      expect(output).not.toHaveProperty('truncated');
      expect(output).not.toHaveProperty('shown');
      expect(output).not.toHaveProperty('cap');
      expect(output.notice).toBe(notice);
      const text = textOf(result);
      expect(text).not.toContain('**Cursor:**');
      expect(text).not.toContain('Pass the returned cursor');
      if (notice) expect(text).toContain(notice);
      else expect(text).toContain('Science');
      expect(http.calls).toHaveLength(1);
    },
  );

  it('does not infer continuation from a full page without a cursor', async () => {
    catalog({ feeds: [SCIENCE] });
    const result = await runToolContract(bskySearchFeeds, { query: 'science', limit: 1 });
    expect(structured(result).feeds).toHaveLength(1);
    expect(structured(result)).not.toHaveProperty('cursor');
    expect(structured(result)).not.toHaveProperty('truncated');
    expect(structured(result)).not.toHaveProperty('notice');
  });

  it.each([404, 410])(
    'returns the declared catalog recovery on HTTP %s without retrying',
    async (status) => {
      catalog({ error: 'NotFound', message: 'Unavailable' }, status);
      const result = await runToolContract(bskySearchFeeds, { query: 'science' });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'catalog_unavailable' },
      });
      const recovery =
        'Try again later, or discover current topic feeds through bsky_get_trending and read a returned feedUri with bsky_get_feed.';
      expect(errorOf(result).data?.recovery?.hint).toBe(recovery);
      expect(textOf(result)).toContain(recovery);
      expect(http.calls).toHaveLength(1);
    },
  );

  it('keeps a provider parameter rejection an error and never retries it', async () => {
    catalog({ error: 'InvalidRequest', message: 'Invalid request' }, 400);
    const result = await runToolContract(bskySearchFeeds, { query: 'science', cursor: 'rejected' });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(textOf(result)).toContain('400');
    expect(http.calls).toHaveLength(1);
  });

  it('retries a transient failure and returns the subsequent catalog page', async () => {
    vi.useFakeTimers();
    http.route({
      match: (request) => new URL(request.url).pathname === CATALOG,
      respond: () =>
        http.calls.length === 1
          ? Response.json({ error: 'InternalServerError' }, { status: 503 })
          : Response.json({ feeds: [SCIENCE] }),
    });
    const pending = runToolContract(bskySearchFeeds, { query: 'science' });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(structured(result).feeds[0]?.feedUri).toBe(FEED);
    expect(textOf(result)).toContain(FEED);
    expect(http.calls).toHaveLength(2);
  });

  it('bounds all response-body attempts by one 45-second deadline', async () => {
    vi.useFakeTimers();
    http.route({
      match: (request) => new URL(request.url).pathname === CATALOG,
      respond: (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              request.signal.addEventListener(
                'abort',
                () => controller.error(request.signal.reason),
                { once: true },
              );
            },
          }),
        ),
    });
    let settled = false;
    const pending = runToolContract(bskySearchFeeds, { query: 'science' }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(settled).toBe(false);
    expect(http.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 45_000, retryAttempts: 3 },
    });
    expect(textOf(result)).toContain('45000ms retry deadline');
    expect(http.calls).toHaveLength(3);
    expect(http.calls.every((call) => call.request.signal.aborted)).toBe(true);
  });

  it('preserves caller cancellation during the response body and stops before any retry', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    http.route({
      match: (request) => new URL(request.url).pathname === CATALOG,
      respond: (request) =>
        new Response(
          new ReadableStream({
            start(stream) {
              request.signal.addEventListener('abort', () => stream.error(request.signal.reason), {
                once: true,
              });
              bodyStarted();
            },
          }),
        ),
    });
    const pending = runToolContract(
      bskySearchFeeds,
      { query: 'science' },
      { context: { signal: controller.signal } },
    );
    await started;
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(textOf(result)).toContain('aborted');
    await vi.runAllTimersAsync();
    expect(http.calls).toHaveLength(1);
  });

  it.each(['', ' ', '\n\t', 'x'.repeat(501)])(
    'rejects invalid query %j without any request',
    async (query) => {
      const result = await runToolContract(bskySearchFeeds, { query });
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(textOf(result)).toContain('query');
      expect(http.calls).toHaveLength(0);
    },
  );

  it('rejects malformed upstream catalog records rather than fabricating an empty catalog', async () => {
    catalog({
      feeds: [{ uri: FEED, displayName: 'Science', creator: { did: 'did:plc:missing-handle' } }],
    });
    const result = await runToolContract(bskySearchFeeds, { query: 'science' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('No feeds matched');
    expect(http.calls).toHaveLength(1);
  });
});

describe('catalog workflow public-route characterization', () => {
  it('registers keyless feed catalog search with and without post-search credentials', () => {
    for (const enabled of [false, true]) {
      expect(
        serverTools(enabled).find((definition) => definition.name === 'bsky_search_feeds'),
      ).toBeDefined();
    }
  });
  it('reads a DID-form feed without a lookup or login even with search credentials configured', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname === '/xrpc/app.bsky.feed.getFeed',
      respond: () => Response.json({ feed: [] }),
    });
    const result = await runToolContract(bskyGetFeed, { feed: FEED, limit: 2 });
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    const request = http.calls[0]!.request;
    expect(new URL(request.url).origin).toBe('https://api.bsky.app');
    expect(new URL(request.url).searchParams.get('feed')).toBe(FEED);
    expect(request.headers.has('authorization')).toBe(false);
    expect(result.structuredContent).toMatchObject({ posts: [], totalReturned: 0 });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('No posts on this page.'),
        }),
      ]),
    );
  });
});

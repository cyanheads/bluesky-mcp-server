/**
 * @fileoverview BlueskyService at the HTTP seam — the real `fetchWithTimeout` and `withRetry` over a
 * faked global `fetch`, so status mapping, retry, error-body handling, and request headers are the
 * production code paths rather than stubs. Any request no test routed rejects with `unmocked fetch`.
 * @module tests/services/bluesky/bluesky-service.http.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyProfileResource } from '@/mcp-server/resources/definitions/bsky-profile.resource.js';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { bskyGetList } from '@/mcp-server/tools/definitions/bsky-get-list.tool.js';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { bskyGetProfile } from '@/mcp-server/tools/definitions/bsky-get-profile.tool.js';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { getBlueskyService, initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

/** An XRPC error envelope with the given status. */
const xrpcError = (status: number, error: string, message: string) =>
  Response.json({ error, message }, { status });

/** Structured error carried on a tool error envelope. */
type ErrorEnvelope = {
  code: number;
  message: string;
  data?: { reason?: string; recovery?: { hint?: string } } & Record<string, unknown>;
};

const errorOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: ErrorEnvelope }).error;

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});

afterEach(() => {
  http.restore();
});

describe('feed references', () => {
  const did = 'did:plc:z72i7hdynmk6r22z27h6tvur';
  it('passes an empty intermediate list-feed cursor through without an existence request', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname.endsWith('.resolveHandle'),
      respond: () => Response.json({ did }),
    });
    http.route({
      match: (request) => new URL(request.url).pathname.endsWith('.getListFeed'),
      respond: () => Response.json({ feed: [], cursor: 'list-next' }),
    });
    const result = await getBlueskyService().getFeed(
      { feed: 'https://bsky.app/profile/bsky.app/lists/news', limit: 1 },
      createMockContext(),
    );
    expect(result).toEqual({
      feedUri: `at://${did}/app.bsky.graph.list/news`,
      posts: [],
      cursor: 'list-next',
    });
    expect(http.calls).toHaveLength(2);
    const url = new URL(http.calls[1]?.request.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      list: `at://${did}/app.bsky.graph.list/news`,
      limit: '1',
    });
  });

  it('keeps generator requests keyless with one handle resolution and the original cursor', async () => {
    http.route({
      match: (request) => new URL(request.url).pathname.endsWith('.resolveHandle'),
      respond: () => Response.json({ did }),
    });
    http.route({
      match: (request) => new URL(request.url).pathname.endsWith('.getFeed'),
      respond: () => Response.json({ feed: [], cursor: 'generator-next' }),
    });
    const result = await getBlueskyService().getFeed(
      { feed: 'https://bsky.app/profile/bsky.app/feed/whats-hot', limit: 1, cursor: 'original' },
      createMockContext(),
    );
    expect(result).toEqual({
      feedUri: `at://${did}/app.bsky.feed.generator/whats-hot`,
      posts: [],
      cursor: 'generator-next',
    });
    expect(http.calls).toHaveLength(2);
    const url = new URL(http.calls[1]?.request.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      feed: `at://${did}/app.bsky.feed.generator/whats-hot`,
      limit: '1',
      cursor: 'original',
    });
  });
});

describe('metadata projection', () => {
  const actor = { did: 'did:plc:test', handle: 'test.bsky.social' };
  const route = (method: string, body: unknown) =>
    http.route({
      match: (request) => {
        const url = new URL(request.url);
        return url.origin === 'https://api.bsky.app' && url.pathname === `/xrpc/${method}`;
      },
      respond: () => Response.json(body),
    });

  it('characterizes sparse profile and actor summaries without inventing optional facts', async () => {
    route('app.bsky.actor.getProfile', actor);
    route('app.bsky.actor.searchActors', { actors: [actor] });
    const profile = await runToolContract(bskyGetProfile, { actor: actor.handle });
    const search = await runToolContract(bskySearchActors, { query: 'test' });
    expect(profile.structuredContent).toEqual(actor);
    expect(search.structuredContent).toMatchObject({ actors: [actor] });
    expect(textOf(profile)).not.toContain('**Associated:**');
    expect(textOf(search)).not.toContain('**Joined:**');
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    [
      { lists: 2, feedgens: 0, starterPacks: 1, labeler: false, chat: { allowIncoming: 'all' } },
      { lists: 2, feedgens: 0, starterPacks: 1, labeler: false },
      ['lists: 2', 'feedgens: 0', 'starterPacks: 1', 'labeler: false'],
    ],
    [{ labeler: true }, { labeler: true }, ['labeler: true']],
    [{ lists: 0 }, { lists: 0 }, ['lists: 0']],
    [{}, {}, ['(empty)']],
  ])(
    'retains selected associated metadata on the profile tool and resource (%j)',
    async (associated, expected, lines) => {
      route('app.bsky.actor.getProfile', { ...actor, associated });
      const result = await runToolContract(bskyGetProfile, { actor: actor.handle });
      const resource = await bskyProfileResource.handler(
        { actor: actor.handle },
        createMockContext({ errors: bskyProfileResource.errors }),
      );
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toHaveProperty('associated', expected);
      expect(resource).toHaveProperty('associated', expected);
      for (const line of lines) expect(textOf(result)).toContain(line);
      expect(textOf(result)).not.toContain('chat');
      expect(http.calls).toHaveLength(2);
    },
  );

  it.each(['search', 'followers', 'following'] as const)(
    'retains account age and every sparse label field on %s',
    async (kind) => {
      const createdAt = '2023-01-01T00:00:00Z';
      const labels = [
        { val: 'only' },
        { val: 'source', src: 'did:plc:labeler' },
        { val: 'time', cts: '2026-01-01T00:00:00Z' },
        { val: 'both', src: 'did:plc:other', cts: '2026-02-01T00:00:00Z' },
      ];
      const full = {
        ...actor,
        createdAt,
        labels,
        pronouns: 'they/he',
        associated: { labeler: true },
      };
      const method =
        kind === 'search'
          ? 'app.bsky.actor.searchActors'
          : kind === 'followers'
            ? 'app.bsky.graph.getFollowers'
            : 'app.bsky.graph.getFollows';
      route(
        method,
        kind === 'search'
          ? { actors: [full, { did: 'did:plc:sparse', handle: 'sparse.bsky.social' }] }
          : {
              subject: full,
              [kind === 'followers' ? 'followers' : 'follows']: [
                full,
                { did: 'did:plc:sparse', handle: 'sparse.bsky.social' },
              ],
            },
      );
      const result =
        kind === 'search'
          ? await runToolContract(bskySearchActors, { query: 'test' })
          : await runToolContract(bskyGetFollows, { actor: actor.handle, direction: kind });
      expect(result.structuredContent).toMatchObject({
        actors: [
          { ...actor, createdAt, labels, pronouns: 'they/he' },
          { did: 'did:plc:sparse', handle: 'sparse.bsky.social' },
        ],
      });
      const data = result.structuredContent as { actors: Array<Record<string, unknown>> };
      expect(data.actors[0]).not.toHaveProperty('associated');
      expect(data.actors[1]).not.toHaveProperty('createdAt');
      if (kind !== 'search')
        expect(result.structuredContent).toHaveProperty('subject.createdAt', createdAt);
      const text = textOf(result);
      expect(text).toContain('**Joined:** 2023-01-01T00:00:00Z');
      expect(text).toContain(
        '**Labels:** only, source src:did:plc:labeler, time cts:2026-01-01T00:00:00Z, both src:did:plc:other cts:2026-02-01T00:00:00Z',
      );
      expect(text).toContain('**Pronouns:** they/he');
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each(['direct', 'media', 'quoted', 'nested'] as const)(
    'retains multiline video alt on %s embeds through both channels',
    async (placement) => {
      const alt = 'Video description\n\n## Heading\n[link](https://example.com)';
      const video = {
        $type: 'app.bsky.embed.video#view',
        playlist: 'https://video.example/playlist.m3u8',
        thumbnail: 'https://video.example/thumb.jpg',
        presentation: 'gif',
        alt,
      };
      const quote = (embeds: unknown[]) => ({
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: 'at://did:plc:test/app.bsky.feed.post/quote',
          cid: 'quote-cid',
          value: { text: 'quoted' },
          embeds,
        },
      });
      const embed =
        placement === 'direct'
          ? video
          : placement === 'media'
            ? { $type: 'app.bsky.embed.recordWithMedia#view', record: quote([]), media: video }
            : placement === 'quoted'
              ? quote([video])
              : quote([quote([video])]);
      route('app.bsky.feed.getAuthorFeed', {
        feed: [
          {
            post: {
              uri: 'at://did:plc:test/app.bsky.feed.post/post',
              cid: 'cid',
              author: actor,
              record: { text: 'post' },
              embed,
            },
          },
        ],
      });
      const result = await runToolContract(bskyGetAuthorFeed, { actor: actor.handle });
      expect(result.isError).toBeFalsy();
      const json = JSON.stringify(result.structuredContent);
      expect(json).toContain(JSON.stringify(alt));
      const text = textOf(result);
      expect(text).toContain(
        '> Video description\n   >\n   > \\## Heading\n   > \\[link\\](https://example.com)',
      );
      const walker = new Parser().parse(text).walker();
      let depth = 0;
      const quoted: string[] = [];
      for (let event = walker.next(); event; event = walker.next()) {
        if (event.node.type === 'block_quote') depth += event.entering ? 1 : -1;
        if (event.entering && depth && event.node.type === 'text')
          quoted.push(event.node.literal ?? '');
        if (event.entering && event.node.type === 'link')
          expect(event.node.destination).not.toBe('https://example.com');
      }
      expect(quoted.join('')).toContain('Video description## Heading[link](https://example.com)');
      expect(text).toContain('https://video.example/playlist.m3u8');
      expect(text).toContain('🎞 GIF: https://video.example/thumb.jpg');
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each([undefined, ''])(
    'omits absent or empty video alt without changing its media (%j)',
    async (alt) => {
      route('app.bsky.feed.getAuthorFeed', {
        feed: [
          {
            post: {
              uri: 'at://did:plc:test/app.bsky.feed.post/post',
              cid: 'cid',
              author: actor,
              record: { text: '' },
              embed: {
                $type: 'app.bsky.embed.video#view',
                playlist: 'https://video.example/playlist',
                ...(alt === undefined ? {} : { alt }),
              },
            },
          },
        ],
      });
      const result = await runToolContract(bskyGetAuthorFeed, { actor: actor.handle });
      expect(result.structuredContent).toHaveProperty('posts.0.embed', {
        type: 'video',
        playlist: 'https://video.example/playlist',
      });
      expect(textOf(result)).toContain('🎬 Video');
      expect(textOf(result)).toContain('Playlist: https://video.example/playlist');
      expect(textOf(result)).not.toContain('>');
    },
  );

  it('preserves embed-depth omission instead of exposing a video beyond the quote bound', async () => {
    const quote = (embed: unknown): unknown => ({
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: 'at://did:plc:test/app.bsky.feed.post/quote',
        cid: 'cid',
        embeds: [embed],
      },
    });
    const embed = quote(
      quote(quote(quote({ $type: 'app.bsky.embed.video#view', alt: 'beyond bound' }))),
    );
    route('app.bsky.feed.getAuthorFeed', {
      feed: [
        {
          post: {
            uri: 'at://did:plc:test/app.bsky.feed.post/post',
            cid: 'cid',
            author: actor,
            record: { text: '' },
            embed,
          },
        },
      ],
    });
    const result = await runToolContract(bskyGetAuthorFeed, { actor: actor.handle });
    expect(JSON.stringify(result.structuredContent)).toContain('"omittedEmbeds":1');
    expect(JSON.stringify(result.structuredContent)).not.toContain('beyond bound');
    expect(textOf(result)).toContain('1 attachment on this quote was not returned');
  });
});

describe('BlueskyService.get — request shape', () => {
  it('reads the public AppView with a User-Agent and no Authorization header', async () => {
    http.route({
      method: 'GET',
      match: /^https:\/\/api\.bsky\.app\/xrpc\/app\.bsky\.actor\.getProfile\?/,
      respond: Response.json({ did: 'did:plc:abc', handle: 'alice.bsky.social' }),
    });

    const profile = await getBlueskyService().getProfile('alice.bsky.social', createMockContext());

    expect(profile).toEqual({ did: 'did:plc:abc', handle: 'alice.bsky.social' });
    const request = http.calls[0]?.request;
    expect(new URL(request?.url ?? '').searchParams.get('actor')).toBe('alice.bsky.social');
    expect(request?.headers.get('user-agent')).toMatch(/\//);
    expect(request?.headers.get('accept')).toBe('application/json');
    expect(request?.headers.has('authorization')).toBe(false);
  });

  it('maps an XRPC 400 to InvalidParams and keeps the JSON body as error data', async () => {
    http.route({
      match: /app\.bsky\.actor\.getProfile/,
      respond: xrpcError(400, 'InvalidRequest', 'Profile not found'),
    });

    const err = await getBlueskyService()
      .getProfile('ghost.bsky.social', createMockContext())
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { status: 400, body: '{"error":"InvalidRequest","message":"Profile not found"}' },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('keeps an HTML block page out of every field of the error', async () => {
    http.route({
      match: /app\.bsky\.actor\.getProfile/,
      respond: new Response(
        '<html><body><h1>403 Forbidden</h1>\nRequest forbidden by administrative rules.\n</body></html>',
        { status: 403, headers: { 'content-type': 'text/html' } },
      ),
    });

    const err = await getBlueskyService()
      .getProfile('alice.bsky.social', createMockContext())
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: JsonRpcErrorCode.Forbidden, data: { status: 403 } });
    expect(
      JSON.stringify({ message: (err as Error).message, data: (err as { data: unknown }).data }),
    ).not.toMatch(/<html|<body|<h1/i);
  });
});

describe('a 500 on a cursored endpoint', () => {
  const INTERNAL = () => xrpcError(500, 'InternalServerError', 'Internal Server Error');
  const authorFeedPage = () =>
    Response.json({
      feed: [
        {
          post: {
            uri: 'at://did:plc:abc/app.bsky.feed.post/a',
            cid: 'bafya',
            author: { did: 'did:plc:abc', handle: 'alice.bsky.social' },
            record: { text: 'hello' },
          },
        },
      ],
    });

  it('bsky_get_author_feed with a caller cursor fails after one request as invalid_cursor', async () => {
    http.route({ match: /app\.bsky\.feed\.getAuthorFeed/, respond: INTERNAL });

    const result = await runToolContract(bskyGetAuthorFeed, {
      actor: 'bsky.app',
      cursor: 'garbage',
    });

    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursor')).toBe('garbage');
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_cursor');
    const declared = bskyGetAuthorFeed.errors?.find((e) => e.reason === 'invalid_cursor')?.recovery;
    expect(error.data?.recovery?.hint).toBe(declared);
    expect(textOf(result)).toContain(declared ?? '<missing>');
    expect(textOf(result)).toContain('invalid_cursor');
  }, 15_000);

  it('bsky_get_author_feed without a cursor still retries a 500', async () => {
    http.route(
      { match: /app\.bsky\.feed\.getAuthorFeed/, once: true, respond: INTERNAL },
      { match: /app\.bsky\.feed\.getAuthorFeed/, respond: authorFeedPage },
    );

    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  }, 15_000);

  it('bsky_get_author_feed with a cursor still retries a 502, which is not how a bad cursor is answered', async () => {
    http.route(
      {
        match: /app\.bsky\.feed\.getAuthorFeed/,
        once: true,
        respond: () => xrpcError(502, 'UpstreamFailure', 'Bad Gateway'),
      },
      { match: /app\.bsky\.feed\.getAuthorFeed/, respond: authorFeedPage },
    );

    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', cursor: 'p2' });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  }, 15_000);

  it('bsky_get_follows, whose endpoint ignores a bad cursor, still retries a 500 that carried one', async () => {
    http.route(
      { match: /app\.bsky\.graph\.getFollows/, once: true, respond: INTERNAL },
      {
        match: /app\.bsky\.graph\.getFollows/,
        respond: Response.json({
          follows: [],
          subject: { did: 'did:plc:abc', handle: 'alice.bsky.social' },
        }),
      },
    );

    const result = await runToolContract(bskyGetFollows, {
      actor: 'alice.bsky.social',
      direction: 'following',
      cursor: 'garbage',
    });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  }, 15_000);
});

describe('a 400 on searchActors', () => {
  /** What `searchActors` answers for a cursor it cannot decode, and for any other rejected parameter. */
  const INVALID = () => xrpcError(400, 'InvalidRequest', 'Invalid request');

  it('bsky_search_actors with a caller cursor fails after one request as invalid_cursor', async () => {
    http.route({ match: /app\.bsky\.actor\.searchActors/, respond: INVALID });

    const result = await runToolContract(bskySearchActors, {
      query: 'bluesky',
      limit: 1,
      cursor: 'garbage',
    });

    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('cursor')).toBe('garbage');
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_cursor');
    expect(error.message).toContain('HTTP 400');
    const declared = bskySearchActors.errors?.find((e) => e.reason === 'invalid_cursor')?.recovery;
    expect(declared).toBeTruthy();
    expect(error.data?.recovery?.hint).toBe(declared);
    expect(textOf(result)).toContain(declared ?? '<missing>');
    expect(textOf(result)).toContain('invalid_cursor');
  });

  it('bsky_search_actors without a cursor keeps the plain 400 failure, after one request', async () => {
    http.route({ match: /app\.bsky\.actor\.searchActors/, respond: INVALID });

    const result = await runToolContract(bskySearchActors, { query: 'bluesky' });

    expect(http.calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBeUndefined();
  });

  it('bsky_search_actors with a cursor still retries a 500', async () => {
    http.route(
      {
        match: /app\.bsky\.actor\.searchActors/,
        once: true,
        respond: () => xrpcError(500, 'InternalServerError', 'Internal Server Error'),
      },
      { match: /app\.bsky\.actor\.searchActors/, respond: () => Response.json({ actors: [] }) },
    );

    const result = await runToolContract(bskySearchActors, { query: 'bluesky', cursor: 'p2' });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  }, 15_000);

  it('bsky_get_author_feed keeps its 500 mapping and leaves a 400 with a cursor unmapped', async () => {
    http.route({
      match: /app\.bsky\.feed\.getAuthorFeed/,
      respond: () => xrpcError(400, 'InvalidRequest', 'Invalid request'),
    });

    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', cursor: 'x' });

    expect(http.calls).toHaveLength(1);
    expect(errorOf(result).data?.reason).not.toBe('invalid_cursor');
  });
});

describe('bsky_get_post_thread — error contract through the real service', () => {
  const uri = 'at://did:plc:abc/app.bsky.feed.post/3lc4gpsxr3c2q';

  it.each([
    ['app.bsky.feed.threadgate', 'did:plc:abc'],
    ['app.bsky.graph.list', 'alice.bsky.social'],
    ['app.bsky.actor.profile', 'did:plc:abc'],
    ['app.bsky.graph.starterpack', 'did:plc:abc'],
  ])('rejects the %s collection locally with useful recovery', async (collection, authority) => {
    http.route({
      match: (request) => new URL(request.url).origin === 'https://api.bsky.app',
      respond: xrpcError(400, 'NotFound', 'Post not found'),
    });
    const result = await runToolContract(bskyGetPostThread, {
      uri: `at://${authority}/${collection}/nonexistent-record`,
    });
    const error = errorOf(result);
    expect(result.isError).toBe(true);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('uri_not_post');
    expect(error.message).toContain(collection);
    const recovery =
      'Use a post URI in app.bsky.feed.post from bsky_get_author_feed or bsky_get_feed, or paste that post’s bsky.app URL.';
    expect(error.data?.recovery?.hint).toBe(recovery);
    expect(textOf(result)).toContain(collection);
    expect(textOf(result)).toContain(recovery);
    expect(http.calls).toHaveLength(0);
  });

  it('reports post_not_found with its recovery hint on both surfaces', async () => {
    http.route({
      match: /app\.bsky\.feed\.getPostThread/,
      respond: xrpcError(400, 'NotFound', `Post not found: ${uri}`),
    });

    const result = await runToolContract(bskyGetPostThread, { uri });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('post_not_found');
    expect(error.data?.recovery?.hint).toBeTruthy();
    expect(textOf(result)).toContain(error.data?.recovery?.hint ?? '');
  });

  it('reports invalid_at_uri with its recovery hint on both surfaces', async () => {
    http.route({
      match: /app\.bsky\.feed\.getPostThread/,
      respond: xrpcError(400, 'InvalidRequest', 'Invalid at-uri'),
    });

    const result = await runToolContract(bskyGetPostThread, { uri });

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_at_uri');
    expect(textOf(result)).toContain(error.data?.recovery?.hint ?? '');
  });

  it.each([
    'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot',
    'at://bsky.app/app.bsky.feed.generator/whats-hot',
  ])('routes a feed generator AT-URI to bsky_get_feed before any request: %s', async (feed) => {
    const result = await runToolContract(bskyGetPostThread, { uri: feed });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('uri_is_feed');
    expect(error.message).toContain('bsky_get_feed');
    expect(error.data?.recovery?.hint).toContain('bsky_get_feed');
    expect(textOf(result)).toContain('bsky_get_feed');
    expect(http.calls).toHaveLength(0);
  });

  it('sends a post AT-URI to getPostThread unchanged, as before', async () => {
    http.route({
      match: /app\.bsky\.feed\.getPostThread/,
      respond: Response.json({
        thread: {
          $type: 'app.bsky.feed.defs#threadViewPost',
          post: {
            uri,
            cid: 'bafy',
            author: { did: 'did:plc:abc', handle: 'alice.bsky.social' },
            record: { text: 'hello' },
          },
        },
      }),
    });

    const result = await runToolContract(bskyGetPostThread, { uri });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    const sent = new URL(http.calls[0]?.request.url ?? '');
    expect(sent.pathname).toBe('/xrpc/app.bsky.feed.getPostThread');
    expect(sent.searchParams.get('uri')).toBe(uri);
    expect(
      (result.structuredContent as { thread: { post: { uri: string } } }).thread.post.uri,
    ).toBe(uri);
  });
});

describe('upstream responses this server cannot read', () => {
  const did = 'did:plc:z72i7hdynmk6r22z27h6tvur';
  const reads: Array<
    [string, RegExp, (service: ReturnType<typeof getBlueskyService>) => Promise<unknown>]
  > = [
    [
      'the feed catalog',
      /getPopularFeedGenerators/,
      (service) => service.searchFeeds({ query: 'science', limit: 5 }, createMockContext()),
    ],
    [
      'a list',
      /app\.bsky\.graph\.getList\b/,
      (service) =>
        service.getList(
          { list: `at://${did}/app.bsky.graph.list/news`, limit: 5 },
          createMockContext(),
        ),
    ],
    [
      'a starter pack',
      /getStarterPack\b/,
      (service) =>
        service.getList(
          { list: `at://${did}/app.bsky.graph.starterpack/pack`, limit: 5 },
          createMockContext(),
        ),
    ],
    [
      'list discovery',
      /getLists\b/,
      (service) =>
        service.discoverCollections({ actor: did, kind: 'lists', limit: 5 }, createMockContext()),
    ],
    [
      'starter pack discovery',
      /getActorStarterPacks/,
      (service) =>
        service.discoverCollections(
          { actor: did, kind: 'starterPacks', limit: 5 },
          createMockContext(),
        ),
    ],
  ];

  it.each(reads)(
    'reports a reshaped %s response as Bluesky being unavailable, never as the caller’s invalid input',
    async (_label, match, read) => {
      http.route({ match, respond: () => Response.json({ unexpected: [{ shape: 1 }] }) });

      const error = await read(getBlueskyService()).then(
        () => undefined,
        (err: unknown) => err as { code?: number; message?: string; cause?: unknown },
      );

      expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error?.message).toMatch(/could not read/);
      expect(error?.cause).toBeInstanceOf(Error);
      expect(http.calls).toHaveLength(1);
    },
  );
});

describe('handle resolution — one resolver for every handle authority', () => {
  const did = 'did:plc:eclio37ymobqex2ncko63h4r';
  const RESOLVE_HANDLE = 'com.atproto.identity.resolveHandle';
  /** 255 characters: it passes every input pattern, and the AppView rejects it as malformed. */
  const LONG = `${`${'a'.repeat(60)}.`.repeat(4)}example.com`;
  const lexicon = (name: string) => (request: Request) =>
    new URL(request.url).pathname === `/xrpc/${name}`;
  const sent = () => http.calls.map(({ request }) => new URL(request.url));
  const lexicons = () => sent().map((url) => url.pathname.slice('/xrpc/'.length));
  /** How the AppView answers a handle it rejects as malformed, as measured live. */
  const invalidHandle = (handle: string) =>
    xrpcError(
      400,
      'InvalidRequest',
      `Invalid com.atproto.identity.resolveHandle params: Invalid handle (got "${handle}")`,
    );
  const MISSING_MEMBERSHIP =
    'Starter pack membership is unavailable because Bluesky could not find its backing list.';

  afterEach(() => {
    vi.useRealTimers();
  });

  /** One collection caller and one other caller of the resolver, with what each reads next. */
  const callers = [
    {
      path: 'a collection read (bsky_get_list on a list)',
      run: (authority: string) =>
        runToolContract(bskyGetList, { list: `at://${authority}/app.bsky.graph.list/news` }),
      record: 'app.bsky.graph.getList',
      answer: () =>
        Response.json({
          list: {
            uri: `at://${did}/app.bsky.graph.list/news`,
            name: 'News',
            creator: { did, handle: 'nytimes.com' },
            purpose: 'app.bsky.graph.defs#curatelist',
          },
          items: [],
        }),
      target: ['list', `at://${did}/app.bsky.graph.list/news`],
      reason: 'list_not_found',
      hint: bskyGetList.errors?.find((e) => e.reason === 'list_not_found')?.recovery,
    },
    {
      path: 'a generator feed (bsky_get_feed)',
      run: (authority: string) =>
        runToolContract(bskyGetFeed, { feed: `at://${authority}/app.bsky.feed.generator/news` }),
      record: 'app.bsky.feed.getFeed',
      answer: () => Response.json({ feed: [] }),
      target: ['feed', `at://${did}/app.bsky.feed.generator/news`],
      reason: 'feed_not_found',
      hint: bskyGetFeed.errors?.find((e) => e.reason === 'feed_not_found')?.recovery,
    },
  ] as const;

  describe.each(callers)('through $path', ({ run, record, answer, target, reason, hint }) => {
    it('sends a mixed-case handle lowercased and reads the record at the DID it names', async () => {
      http.route(
        { match: lexicon(RESOLVE_HANDLE), respond: () => Response.json({ did }) },
        { match: lexicon(record), respond: answer },
      );

      const result = await run('NYTimes.COM');

      expect(result.isError).toBeFalsy();
      expect(lexicons()).toEqual([RESOLVE_HANDLE, record]);
      expect(sent()[0]?.searchParams.get('handle')).toBe('nytimes.com');
      expect(sent()[1]?.searchParams.get(target[0])).toBe(target[1]);
    });

    it.each([
      ['InvalidRequest, its answer to a malformed handle', LONG, () => invalidHandle(LONG)],
      [
        'HandleNotFound, the lexicon’s declared error',
        'missing.example.com',
        () => xrpcError(400, 'HandleNotFound', 'Unable to resolve handle'),
      ],
    ])(
      'maps a 400 %s to the caller’s not-found, before any record request',
      async (_label, handle, respond) => {
        http.route(
          { match: lexicon(RESOLVE_HANDLE), respond },
          { match: lexicon(record), respond: answer },
        );

        const result = await run(handle);

        expect(result.isError).toBe(true);
        expect(hint).toBeTruthy();
        expect(errorOf(result)).toMatchObject({
          code: JsonRpcErrorCode.NotFound,
          data: { reason, recovery: { hint } },
        });
        expect(textOf(result)).toContain(hint ?? '<missing>');
        expect(lexicons()).toEqual([RESOLVE_HANDLE]);
      },
    );

    it('leaves a 400 without an XRPC envelope as an ordinary failure, after one request', async () => {
      http.route({
        match: lexicon(RESOLVE_HANDLE),
        respond: () => new Response('Bad Request', { status: 400 }),
      });

      const result = await run('nytimes.com');

      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(errorOf(result).data?.reason).toBeUndefined();
      expect(lexicons()).toEqual([RESOLVE_HANDLE]);
    });

    it.each([
      [429, 'RateLimitExceeded', 'Rate Limit Exceeded'],
      [500, 'InternalServerError', 'Internal Server Error'],
      // Only a 400 says the handle is unknown, whatever envelope another status carries.
      [500, 'InvalidRequest', 'Invalid request'],
    ])(
      'retries a %i %s instead of reporting the handle missing',
      async (status, error, message) => {
        vi.useFakeTimers();
        http.route(
          {
            match: lexicon(RESOLVE_HANDLE),
            once: true,
            respond: () => xrpcError(status, error, message),
          },
          { match: lexicon(RESOLVE_HANDLE), respond: () => Response.json({ did }) },
          { match: lexicon(record), respond: answer },
        );

        const pending = run('nytimes.com');
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.isError).toBeFalsy();
        expect(lexicons()).toEqual([RESOLVE_HANDLE, RESOLVE_HANDLE, record]);
      },
    );

    it.each([
      ['a value that is no identifier', 'not-a-did'],
      ['a handle, which the actor pattern also accepts', 'nytimes.com'],
    ])(
      'fails an answer that is %s as ServiceUnavailable, and never reads the record',
      async (_label, answered) => {
        http.route(
          { match: lexicon(RESOLVE_HANDLE), respond: () => Response.json({ did: answered }) },
          { match: lexicon(record), respond: answer },
        );

        const result = await run('nytimes.com');

        expect(result.isError).toBe(true);
        expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(errorOf(result).data?.reason).toBeUndefined();
        expect(textOf(result)).toContain(
          `${RESOLVE_HANDLE} with a response this server could not read`,
        );
        expect(lexicons()).toEqual([RESOLVE_HANDLE]);
      },
    );
  });

  it('bounds a collection read’s handle resolution by the caller’s deadline', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    http.route({
      match: lexicon(RESOLVE_HANDLE),
      respond: (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    });

    const pending = getBlueskyService()
      .getFeed(
        { feed: 'at://nytimes.com/app.bsky.graph.list/news', deadlineAtMs: start + 1_000 },
        createMockContext(),
      )
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    await vi.advanceTimersByTimeAsync(999);
    expect(lexicons()).toEqual([RESOLVE_HANDLE]);
    expect(http.calls[0]?.request.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(http.calls[0]?.request.signal.aborted).toBe(true);
    expect(await pending).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(lexicons()).toEqual([RESOLVE_HANDLE]);
    expect(Date.now() - start).toBe(1_000);
  });

  it.each([
    [
      'bsky_get_feed on a list',
      () => runToolContract(bskyGetFeed, { feed: `at://${LONG}/app.bsky.graph.list/news` }),
      'list_not_found',
      bskyGetFeed.errors?.find((e) => e.reason === 'list_not_found')?.recovery,
    ],
    [
      'bsky_get_list on a starter pack',
      () => runToolContract(bskyGetList, { list: `at://${LONG}/app.bsky.graph.starterpack/pack` }),
      'starter_pack_not_found',
      bskyGetList.errors?.find((e) => e.reason === 'starter_pack_not_found')?.recovery,
    ],
  ])(
    '%s reports its own not-found when Bluesky rejects the owner handle',
    async (_label, run, reason, hint) => {
      http.route({ match: lexicon(RESOLVE_HANDLE), respond: () => invalidHandle(LONG) });

      const result = await run();

      expect(result.isError).toBe(true);
      expect(hint).toBeTruthy();
      expect(errorOf(result)).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason, recovery: { hint } },
      });
      expect(textOf(result)).toContain(hint ?? '<missing>');
      expect(lexicons()).toEqual([RESOLVE_HANDLE]);
    },
  );

  it('returns a starter pack whose backing-list owner handle Bluesky rejects, with the membership notice', async () => {
    const pack = `at://${did}/app.bsky.graph.starterpack/pack`;
    http.route(
      {
        match: lexicon('app.bsky.graph.getStarterPack'),
        respond: () =>
          Response.json({
            starterPack: {
              uri: pack,
              creator: { did, handle: 'nytimes.com' },
              record: { name: 'Pack', list: `at://${LONG}/app.bsky.graph.list/members` },
            },
          }),
      },
      { match: lexicon(RESOLVE_HANDLE), respond: () => invalidHandle(LONG) },
    );

    const result = await runToolContract(bskyGetList, { list: pack });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      starterPack: { uri: pack, listUri: `at://${LONG}/app.bsky.graph.list/members` },
      notice: MISSING_MEMBERSHIP,
    });
    expect(textOf(result)).toContain(MISSING_MEMBERSHIP);
    expect(lexicons()).toEqual(['app.bsky.graph.getStarterPack', RESOLVE_HANDLE]);
  });
});

/**
 * `getLists` and `getActorStarterPacks` answer an unknown DID with 200 and an empty page, where an
 * unknown handle gets 400 `Profile not found`. An empty first page for a DID is checked with one
 * `getProfile`; only its `Profile not found` changes the answer.
 */
describe.each([
  { kind: 'lists', lexicon: 'app.bsky.graph.getLists' },
  { kind: 'starterPacks', lexicon: 'app.bsky.graph.getActorStarterPacks' },
] as const)('actor discovery of $kind for a DID', ({ kind, lexicon }) => {
  const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
  const PROFILE = 'app.bsky.actor.getProfile';
  const at = (name: string) => (request: Request) =>
    new URL(request.url).pathname === `/xrpc/${name}`;
  const serve = (body: Record<string, unknown> = {}) =>
    http.route({ match: at(lexicon), respond: () => Response.json({ [kind]: [], ...body }) });
  const serveProfile = (respond: (request: Request) => Response | Promise<Response>) =>
    http.route({ match: at(PROFILE), respond });
  const sent = () =>
    http.calls.map(({ request }) => {
      const url = new URL(request.url);
      return [url.pathname.slice('/xrpc/'.length), Object.fromEntries(url.searchParams)];
    });
  const discover = (params: { actor?: string; cursor?: string } = {}, ctx = createMockContext()) =>
    getBlueskyService().discoverCollections({ actor: did, kind, limit: 5, ...params }, ctx);
  const emptyPage = { kind, [kind]: [] };
  const unconfirmedPage = { ...emptyPage, actorUnconfirmed: true };

  it.each([
    ['without a cursor', {}],
    ['with the empty cursor that ends a stream', { cursor: '' }],
  ])(
    'fails as actor_not_found after exactly two requests when the page ends %s',
    async (_label, body) => {
      serve(body);
      serveProfile(() => xrpcError(400, 'InvalidRequest', 'Profile not found'));

      await expect(discover()).rejects.toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'actor_not_found' },
      });
      expect(sent()).toEqual([
        [lexicon, { actor: did, limit: '5' }],
        [PROFILE, { actor: did }],
      ]);
    },
  );

  it('returns the empty page for an account that exists, after one profile request', async () => {
    serve();
    serveProfile(() => Response.json({ did, handle: 'quiet.bsky.social' }));

    await expect(discover()).resolves.toEqual(emptyPage);
    expect(sent().map(([name]) => name)).toEqual([lexicon, PROFILE]);
  });

  it.each([
    [
      '503 the retry budget cannot wait out',
      () =>
        Response.json({ error: 'Unavailable' }, { status: 503, headers: { 'Retry-After': '31' } }),
    ],
    [
      '429 the retry budget cannot wait out',
      () =>
        Response.json(
          { error: 'RateLimitExceeded' },
          { status: 429, headers: { 'Retry-After': '31' } },
        ),
    ],
    ['different 400', () => xrpcError(400, 'AccountDeactivated', 'Account is deactivated')],
  ])(
    'marks the empty page unconfirmed when the profile check answers a %s',
    async (_label, respond) => {
      serve();
      serveProfile(respond);

      await expect(discover()).resolves.toEqual(unconfirmedPage);
      expect(sent().map(([name]) => name)).toEqual([lexicon, PROFILE]);
    },
  );

  it('marks the empty page unconfirmed when every profile attempt comes back unreadable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      serve();
      serveProfile(() => new Response('not json', { status: 200 }));

      const pending = discover();
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toEqual(unconfirmedPage);
      const names = sent().map(([name]) => name);
      expect(names[0]).toBe(lexicon);
      expect(names.length).toBeGreaterThan(2);
      expect(names.slice(1).every((name) => name === PROFILE)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the empty page unconfirmed without a profile request once the collection deadline is spent', async () => {
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    try {
      http.route({
        match: at(lexicon),
        respond: () => {
          clock.mockReturnValue(start + 46_000);
          return Response.json({ [kind]: [] });
        },
      });
      // A routed profile records a check the spent deadline should have prevented.
      serveProfile(() => Response.json({ did, handle: 'quiet.bsky.social' }));

      await expect(discover()).resolves.toEqual(unconfirmedPage);
      expect(sent().map(([name]) => name)).toEqual([lexicon]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['one request timeout when more of the collection deadline is left', 0, 15_000],
    [
      'the rest of the collection deadline when less than a request timeout is left',
      35_000,
      10_000,
    ],
  ])('settles a hung profile check as unconfirmed after %s', async (_label, spentMs, boundMs) => {
    vi.useFakeTimers();
    try {
      http.route({
        match: at(lexicon),
        respond: () => {
          vi.setSystemTime(Date.now() + spentMs);
          return Response.json({ [kind]: [] });
        },
      });
      serveProfile(
        (request) =>
          new Promise<Response>((_resolve, reject) =>
            request.signal.addEventListener('abort', () => reject(request.signal.reason), {
              once: true,
            }),
          ),
      );

      let page: unknown;
      const pending = discover().then((value) => {
        page = value;
      });
      await vi.advanceTimersByTimeAsync(boundMs - 1);
      expect(page).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);

      expect(page).toEqual(unconfirmedPage);
      await pending;
      expect(sent().map(([name]) => name)).toEqual([lexicon, PROFILE]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows the caller’s cancellation during the profile check instead of degrading', async () => {
    const caller = new AbortController();
    serve();
    serveProfile(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
          caller.abort();
        }),
    );

    const settled = await discover({}, createMockContext({ signal: caller.signal })).then(
      (page) => ({ page }),
      (error: unknown) => ({ error }),
    );

    expect(settled).toEqual({ error: caller.signal.reason });
    expect(caller.signal.reason).toHaveProperty('name', 'AbortError');
    expect(sent().map(([name]) => name)).toEqual([lexicon, PROFILE]);
  });

  /**
   * A profile route that answers 200 records any stray check in `sent()`, where an unrouted one
   * would fail unrecorded and only mark the page unconfirmed.
   */
  it.each([
    ['a handle', { actor: 'nytimes.com' }, {}, { actor: 'nytimes.com', limit: '5' }],
    [
      'a call that followed a cursor',
      { cursor: 'c1' },
      {},
      { actor: did, limit: '5', cursor: 'c1' },
    ],
    [
      'an empty page that still carries a cursor',
      {},
      { cursor: 'next' },
      { actor: did, limit: '5' },
    ],
  ])('spends no profile request on %s', async (_label, params, body, query) => {
    serve(body);
    serveProfile(() => Response.json({ did, handle: 'quiet.bsky.social' }));

    await expect(discover(params)).resolves.toEqual({ ...emptyPage, ...body });
    expect(sent()).toEqual([[lexicon, query]]);
  });

  it('spends no profile request on a page that holds a collection', async () => {
    const creator = { did, handle: 'curator.bsky.social' };
    const listUri = `at://${did}/app.bsky.graph.list/3lbugqe62cm2n`;
    const packUri = `at://${did}/app.bsky.graph.starterpack/3lbugqemf5427`;
    http.route({
      match: at(lexicon),
      respond: () =>
        Response.json({
          [kind]: [
            kind === 'lists'
              ? {
                  uri: listUri,
                  name: 'Curated',
                  creator,
                  purpose: 'app.bsky.graph.defs#curatelist',
                }
              : { uri: packUri, creator, record: { name: 'Pack', list: listUri } },
          ],
        }),
    });
    serveProfile(() => Response.json({ did, handle: 'curator.bsky.social' }));

    await expect(discover()).resolves.toEqual({
      kind,
      [kind]: [
        kind === 'lists'
          ? { uri: listUri, name: 'Curated', creator, purpose: 'app.bsky.graph.defs#curatelist' }
          : { uri: packUri, creator, name: 'Pack', listUri },
      ],
    });
    expect(sent()).toEqual([[lexicon, { actor: did, limit: '5' }]]);
  });
});

/**
 * The AppView answers an actor that passes the input pattern but fails its own identifier check
 * with 400 `InvalidRequest` naming `Invalid AT identifier`. Such an identifier names no account, so
 * an actor read reports `actor_not_found`; a record read keeps the plain 400.
 */
describe('an identifier the AppView rejects as invalid', () => {
  const did = 'did:plc:z72i7hdynmk6r22z27h6tvur';
  /** 255 characters: it passes every input pattern, and the AppView rejects it as malformed. */
  const LONG = `${`${'a'.repeat(60)}.`.repeat(4)}example.com`;
  const invalidIdentifier = (lexicon: string, value: string) => () =>
    xrpcError(
      400,
      'InvalidRequest',
      `Invalid ${lexicon} params: Invalid AT identifier (got "${value}")`,
    );
  const ctx = createMockContext;

  it.each([
    [
      'Invalid AT identifier on actor discovery to actor_not_found',
      'app.bsky.graph.getLists',
      invalidIdentifier('app.bsky.graph.getLists', LONG),
      () =>
        getBlueskyService().discoverCollections({ actor: LONG, kind: 'lists', limit: 5 }, ctx()),
      'actor_not_found',
    ],
    [
      'Invalid AT identifier on an actor feed read to actor_not_found',
      'app.bsky.feed.getActorFeeds',
      invalidIdentifier('app.bsky.feed.getActorFeeds', LONG),
      () => getBlueskyService().getActorFeeds({ actor: LONG, limit: 5 }, ctx()),
      'actor_not_found',
    ],
    [
      'another InvalidRequest on actor discovery to no reason',
      'app.bsky.graph.getLists',
      () => xrpcError(400, 'InvalidRequest', 'Invalid app.bsky.graph.getLists params: bad cursor'),
      () =>
        getBlueskyService().discoverCollections({ actor: LONG, kind: 'lists', limit: 5 }, ctx()),
      undefined,
    ],
    [
      'Invalid AT identifier on a list read to no reason',
      'app.bsky.graph.getList',
      invalidIdentifier('app.bsky.graph.getList', did),
      () =>
        getBlueskyService().getList(
          { list: `at://${did}/app.bsky.graph.list/news`, limit: 5 },
          ctx(),
        ),
      undefined,
    ],
  ])('maps %s, after one request', async (_label, lexicon, respond, read, reason) => {
    http.route({
      match: (request) => new URL(request.url).pathname === `/xrpc/${lexicon}`,
      respond,
    });

    const error = await read().then(
      () => undefined,
      (err: unknown) => err as { code?: number; data?: { reason?: string } },
    );

    expect(error?.code).toBe(
      reason === undefined ? JsonRpcErrorCode.InvalidParams : JsonRpcErrorCode.NotFound,
    );
    expect(error?.data?.reason).toBe(reason);
    expect(http.calls).toHaveLength(1);
  });
});

/**
 * Collection records Bluesky serves that this server cannot read. The starter pack fixture is the
 * one Bluesky serves at `BAD_PACK`: a record whose `list` misspells the list collection, with no
 * hydrated list view beside it.
 */
describe('collection records Bluesky sent malformed', () => {
  const owner = { did: 'did:plc:xgs3qrwos3dwxmixoflcxrhu', handle: 'devin.divy.zone' };
  const BAD_PACK = `at://${owner.did}/app.bsky.graph.starterpack/3kvrbgdrtbs2v`;
  const UNREADABLE_LIST = 'at://did:web:example/app.bsly.graph.list/example';
  const listUri = (rkey: string) => `at://${owner.did}/app.bsky.graph.list/${rkey}`;
  const packUri = (rkey: string) => `at://${owner.did}/app.bsky.graph.starterpack/${rkey}`;
  const badPack = {
    uri: BAD_PACK,
    creator: owner,
    record: { name: 'Test pack', list: UNREADABLE_LIST },
  };
  /** A pack view as `getActorStarterPacks` sends it, and the projection the server returns. */
  const packView = (rkey: string) => ({
    uri: packUri(rkey),
    creator: owner,
    record: { name: `Pack ${rkey}`, list: listUri(rkey) },
  });
  const pack = (rkey: string) => ({
    uri: packUri(rkey),
    creator: owner,
    name: `Pack ${rkey}`,
    listUri: listUri(rkey),
  });
  const list = (rkey: string) => ({
    uri: listUri(rkey),
    name: `List ${rkey}`,
    creator: owner,
    purpose: 'app.bsky.graph.defs#curatelist',
  });
  const at = (name: string) => (request: Request) =>
    new URL(request.url).pathname === `/xrpc/${name}`;
  const lexicons = () =>
    http.calls.map(({ request }) => new URL(request.url).pathname.slice('/xrpc/'.length));
  /** A last route on the AppView origin, so a request no test expected is recorded too. */
  const recordStrays = () =>
    http.route({
      match: (request) => new URL(request.url).origin === 'https://api.bsky.app',
      respond: () => xrpcError(418, 'Unrouted', 'No route for this request'),
    });
  const discover = (actor: string, kind: 'lists' | 'starterPacks') =>
    getBlueskyService().discoverCollections({ actor, kind, limit: 5 }, createMockContext());

  it('drops a malformed starter pack from discovery, keeps the rest in order, and counts it', async () => {
    http.route({
      match: at('app.bsky.graph.getActorStarterPacks'),
      respond: () =>
        Response.json({ starterPacks: [packView('sp1'), badPack, packView('3kvud4dulq526')] }),
    });
    recordStrays();

    await expect(discover('devin.divy.zone', 'starterPacks')).resolves.toEqual({
      kind: 'starterPacks',
      starterPacks: [pack('sp1'), pack('3kvud4dulq526')],
      unreadable: 1,
    });
    expect(lexicons()).toEqual(['app.bsky.graph.getActorStarterPacks']);
  });

  it('drops a list whose URI is not a list AT-URI and keeps the page’s cursor', async () => {
    http.route({
      match: at('app.bsky.graph.getLists'),
      respond: () =>
        Response.json({
          lists: [list('first'), { ...list('second'), uri: UNREADABLE_LIST }],
          cursor: 'next',
        }),
    });
    recordStrays();

    await expect(discover('devin.divy.zone', 'lists')).resolves.toEqual({
      kind: 'lists',
      lists: [list('first')],
      unreadable: 1,
      cursor: 'next',
    });
    expect(lexicons()).toEqual(['app.bsky.graph.getLists']);
  });

  it('spends no profile check on a DID page whose every row was dropped, since Bluesky sent rows', async () => {
    const badFeed = {
      ...packView('feeds'),
      record: {
        ...packView('feeds').record,
        feeds: [{ uri: 'at://did:web:example/app.bsky.feed.generatr/x' }],
      },
    };
    http.route({
      match: at('app.bsky.graph.getActorStarterPacks'),
      respond: () => Response.json({ starterPacks: [badPack, badFeed] }),
    });
    recordStrays();

    await expect(discover(owner.did, 'starterPacks')).resolves.toEqual({
      kind: 'starterPacks',
      starterPacks: [],
      unreadable: 2,
    });
    expect(lexicons()).toEqual(['app.bsky.graph.getActorStarterPacks']);
  });

  it('reads a starter pack whose backing list reference is not a list AT-URI as membership unavailable, after one request', async () => {
    http.route({
      match: at('app.bsky.graph.getStarterPack'),
      respond: () => Response.json({ starterPack: badPack }),
    });
    recordStrays();

    await expect(
      getBlueskyService().getList({ list: BAD_PACK, limit: 5 }, createMockContext()),
    ).resolves.toEqual({
      kind: 'missingBackingList',
      backingList: 'unreadable',
      starterPack: { uri: BAD_PACK, creator: owner, name: 'Test pack', listUri: UNREADABLE_LIST },
    });
    expect(lexicons()).toEqual(['app.bsky.graph.getStarterPack']);
  });
});

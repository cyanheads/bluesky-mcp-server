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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyProfileResource } from '@/mcp-server/resources/definitions/bsky-profile.resource.js';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
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

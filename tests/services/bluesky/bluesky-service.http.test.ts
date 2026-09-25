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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
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

describe('bsky_get_post_thread — error contract through the real service', () => {
  const uri = 'at://did:plc:abc/app.bsky.feed.post/3lc4gpsxr3c2q';

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

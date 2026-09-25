/**
 * @fileoverview bsky_search_posts through the real service over a faked global `fetch`: the
 * app-password session (lazy create, reuse, refresh, re-create, failure), the PDS + `atproto-proxy`
 * request path, the login-limit latch, and the typed `search_auth_failed` / `search_refused` /
 * `search_login_limited` errors. Any request no test routed rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-search-posts.auth.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { getBlueskyService, initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const CREDENTIALS = { identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' };
const ENTRYWAY = 'https://bsky.social/xrpc';
const PDS = 'https://pds.example.test';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

const HTML_403 =
  '<html><body><h1>403 Forbidden</h1>\nRequest forbidden by administrative rules.\n</body></html>';

const session = (n: number) => ({
  accessJwt: `access-${n}`,
  refreshJwt: `refresh-${n}`,
  did: 'did:plc:operator',
  handle: 'operator.bsky.social',
  didDoc: {
    id: 'did:plc:operator',
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
  },
});

const searchBody = {
  posts: [
    {
      uri: 'at://did:plc:abc/app.bsky.feed.post/r1',
      cid: 'bafyr1',
      author: { did: 'did:plc:abc', handle: 'alice.bsky.social' },
      record: { text: 'hello' },
    },
  ],
  hitsTotal: 1,
};

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
  initBlueskyService(CREDENTIALS);
});

afterEach(() => {
  http.restore();
});

/** Every request the fake saw, as "METHOD host/path". */
const trail = () =>
  http.calls.map((c) => {
    const url = new URL(c.request.url);
    return `${c.request.method} ${url.host}${url.pathname}`;
  });

const CREATE = 'POST bsky.social/xrpc/com.atproto.server.createSession';
const REFRESH = 'POST pds.example.test/xrpc/com.atproto.server.refreshSession';
const SEARCH = 'GET pds.example.test/xrpc/app.bsky.feed.searchPosts';

const createRoute = (respond: Response | (() => Response), once = true) => ({
  method: 'POST',
  match: `${ENTRYWAY}/com.atproto.server.createSession`,
  once,
  respond: typeof respond === 'function' ? () => respond() : respond,
});
const refreshRoute = (respond: Response) => ({
  method: 'POST',
  match: `${PDS}/xrpc/com.atproto.server.refreshSession`,
  once: true,
  respond,
});
const searchRoute = (respond: Response, once = true) => ({
  method: 'GET',
  match: /^https:\/\/pds\.example\.test\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
  once,
  respond,
});

const expiredToken = () =>
  Response.json({ error: 'ExpiredToken', message: 'Token has expired' }, { status: 400 });

/** Bearer token each search request carried, in order. */
const searchTokens = () =>
  http.calls
    .filter((c) => c.request.url.includes('app.bsky.feed.searchPosts'))
    .map((c) => c.request.headers.get('authorization'));

/** Asserts a search_auth_failed envelope with its declared hint, and no credential or token in it. */
function expectAuthFailed(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).toBe(true);
  const error = errorOf(result);
  expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
  expect(error.data?.reason).toBe('search_auth_failed');
  const declared = bskySearchPosts.errors?.find((e) => e.reason === 'search_auth_failed')?.recovery;
  expect(error.data?.recovery?.hint).toBe(declared);
  expect(textOf(result)).toContain(declared ?? '');
  expect(JSON.stringify(result)).not.toMatch(/abcd-efgh|access-\d|refresh-\d/);
}

describe('bsky_search_posts — the app-password session', () => {
  it('logs in lazily, then searches the PDS with the access token and the AppView proxy header', async () => {
    http.route(createRoute(Response.json(session(1))), searchRoute(Response.json(searchBody)));

    const result = await runToolContract(bskySearchPosts, { query: 'weather', limit: 1 });

    expect(result.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, SEARCH]);
    const create = http.calls[0]?.request;
    expect(await create?.json()).toEqual({
      identifier: 'operator.bsky.social',
      password: 'abcd-efgh-ijkl-mnop',
    });
    const search = http.calls[1]?.request;
    expect(search?.headers.get('authorization')).toBe('Bearer access-1');
    expect(search?.headers.get('atproto-proxy')).toBe('did:web:api.bsky.app#bsky_appview');
    expect(new URL(search?.url ?? '').searchParams.get('q')).toBe('weather');
    const posts = (result.structuredContent as { posts: Array<{ uri: string }> }).posts;
    expect(posts.map((p) => p.uri)).toEqual(['at://did:plc:abc/app.bsky.feed.post/r1']);
  });

  it('creates the session once and reuses it', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(Response.json(searchBody), false),
    );

    await runToolContract(bskySearchPosts, { query: 'one' });
    await runToolContract(bskySearchPosts, { query: 'two', cursor: 'page-2' });

    expect(trail()).toEqual([CREATE, SEARCH, SEARCH]);
    expect(searchTokens()).toEqual(['Bearer access-1', 'Bearer access-1']);
    expect(new URL(http.calls[2]?.request.url ?? '').searchParams.get('cursor')).toBe('page-2');
  });

  it('shares one login between concurrent first searches', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(Response.json(searchBody), false),
    );

    const results = await Promise.all([
      runToolContract(bskySearchPosts, { query: 'a' }),
      runToolContract(bskySearchPosts, { query: 'b' }),
      runToolContract(bskySearchPosts, { query: 'c' }),
    ]);

    expect(results.every((r) => !r.isError)).toBe(true);
    expect(trail().filter((t) => t === CREATE)).toHaveLength(1);
  });

  it('sends no request anywhere until a search is made', async () => {
    http.route({
      match: /app\.bsky\.actor\.getProfile/,
      respond: Response.json({ did: 'did:plc:abc', handle: 'alice.bsky.social' }),
    });

    await getBlueskyService().getProfile('alice.bsky.social', createMockContext());

    expect(trail()).toEqual(['GET api.bsky.app/xrpc/app.bsky.actor.getProfile']);
    expect(http.calls[0]?.request.headers.has('authorization')).toBe(false);
  });

  it('falls back to the entryway when the session names no https PDS', async () => {
    const { didDoc: _didDoc, ...withoutDoc } = session(1);
    http.route(createRoute(Response.json(withoutDoc)), {
      match: /^https:\/\/bsky\.social\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
      respond: Response.json(searchBody),
    });

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(result.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, 'GET bsky.social/xrpc/app.bsky.feed.searchPosts']);
  });

  it('never maps viewer state the session hydrates into the result', async () => {
    const [raw] = searchBody.posts;
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(
        Response.json({
          posts: [
            {
              ...raw,
              author: { ...raw?.author, viewer: { muted: true, blockedBy: false } },
              viewer: { bookmarked: true, threadMuted: false },
            },
          ],
        }),
      ),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(JSON.stringify(result)).not.toMatch(/viewer|muted|bookmarked|blockedBy/);
  });
});

describe('bsky_search_posts — renewing a refused token', () => {
  it('refreshes an expired access token and retries the search, rotating both tokens', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(expiredToken()),
      refreshRoute(Response.json(session(2))),
      searchRoute(Response.json(searchBody), false),
    );

    const first = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(first.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH, SEARCH]);
    expect(http.calls[2]?.request.headers.get('authorization')).toBe('Bearer refresh-1');
    expect(searchTokens()).toEqual(['Bearer access-1', 'Bearer access-2']);

    // The rotated pair is the one kept: the next search uses it without renewing again.
    await runToolContract(bskySearchPosts, { query: 'y' });
    expect(searchTokens().at(-1)).toBe('Bearer access-2');
    expect(trail().filter((t) => t === REFRESH || t === CREATE)).toHaveLength(2);
  });

  it('shares one refresh between concurrent searches refused on the same token', async () => {
    http.route(createRoute(Response.json(session(1))), refreshRoute(Response.json(session(2))), {
      method: 'GET',
      match: /^https:\/\/pds\.example\.test\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
      respond: (request: Request) =>
        request.headers.get('authorization') === 'Bearer access-1'
          ? expiredToken()
          : Response.json(searchBody),
    });

    const results = await Promise.all(
      ['a', 'b', 'c'].map((query) => runToolContract(bskySearchPosts, { query })),
    );

    expect(results.every((r) => !r.isError)).toBe(true);
    expect(trail().filter((t) => t === CREATE)).toHaveLength(1);
    expect(trail().filter((t) => t === REFRESH)).toHaveLength(1);
    expect(searchTokens().filter((t) => t === 'Bearer access-2')).toHaveLength(3);
  });

  it('treats a 401 on the search as a refused token too', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(Response.json({ error: 'AuthMissing', message: 'no auth' }, { status: 401 })),
      refreshRoute(Response.json(session(2))),
      searchRoute(Response.json(searchBody)),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(result.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH, SEARCH]);
  });

  it('logs in again when the refresh itself is refused', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(expiredToken()),
      refreshRoute(expiredToken()),
      createRoute(Response.json(session(3))),
      searchRoute(Response.json(searchBody)),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(result.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH, CREATE, SEARCH]);
    expect(searchTokens()).toEqual(['Bearer access-1', 'Bearer access-3']);
  });

  it('fails with search_auth_failed when the re-login is rejected, and never logs in again', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(expiredToken()),
      refreshRoute(expiredToken()),
      createRoute(
        Response.json(
          { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
          { status: 401 },
        ),
      ),
    );

    expectAuthFailed(await runToolContract(bskySearchPosts, { query: 'x' }));
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH, CREATE]);

    // Credentials cannot change while the process runs: no further login is spent on them.
    expectAuthFailed(await runToolContract(bskySearchPosts, { query: 'y' }));
    expect(http.calls).toHaveLength(4);
  });

  it('fails with search_auth_failed when a freshly renewed token is refused too', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(expiredToken()),
      refreshRoute(Response.json(session(2))),
      searchRoute(expiredToken()),
    );

    expectAuthFailed(await runToolContract(bskySearchPosts, { query: 'x' }));
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH, SEARCH]);
  });

  it('propagates a transient refresh failure without spending a login', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(expiredToken()),
      refreshRoute(Response.json({ error: 'InternalServerError', message: 'x' }, { status: 503 })),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH]);
  });

  it('keeps the session through a transient refresh failure, so the next search refreshes instead of logging in', async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(expiredToken()),
      refreshRoute(Response.json({ error: 'InternalServerError', message: 'x' }, { status: 503 })),
      searchRoute(expiredToken()),
      refreshRoute(Response.json(session(2))),
      searchRoute(Response.json(searchBody)),
    );

    await runToolContract(bskySearchPosts, { query: 'x' });
    const second = await runToolContract(bskySearchPosts, { query: 'x' });

    expect(second.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH, SEARCH, REFRESH, SEARCH]);
    expect(http.calls[4]?.request.headers.get('authorization')).toBe('Bearer refresh-1');
  });
});

describe('bsky_search_posts — the login itself', () => {
  it('fails with search_auth_failed on a rejected login, and does not try again', async () => {
    http.route(
      createRoute(
        Response.json(
          { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
          { status: 401 },
        ),
        false,
      ),
    );

    const first = await runToolContract(bskySearchPosts, { query: 'x' });
    expectAuthFailed(first);
    expect(errorOf(first).message).toContain('Invalid identifier or password');
    expectAuthFailed(await runToolContract(bskySearchPosts, { query: 'y' }));
    expect(trail()).toEqual([CREATE]);
  });

  it('never retries a failed login, and tries again on the next search when it was transient', async () => {
    http.route(
      createRoute(Response.json({ error: 'InternalServerError', message: 'x' }, { status: 502 })),
      createRoute(Response.json(session(1))),
      searchRoute(Response.json(searchBody)),
    );

    const first = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(errorOf(first).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(trail()).toEqual([CREATE]);

    const second = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(second.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, CREATE, SEARCH]);
  });

  it("hands concurrent searches a shared failed login without another request's identity", async () => {
    http.route(
      createRoute(Response.json({ error: 'InternalServerError', message: 'x' }, { status: 502 })),
    );

    const results = await Promise.all([
      runToolContract(bskySearchPosts, { query: 'a' }),
      runToolContract(bskySearchPosts, { query: 'b' }),
    ]);

    expect(trail()).toEqual([CREATE]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      const error = errorOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      // The login outlives the request that started it; its failure names no single request.
      expect(error.data).not.toHaveProperty('requestId');
    }
  });

  it('keeps an HTML page from a failed login out of the error', async () => {
    http.route(
      createRoute(
        new Response(HTML_403, { status: 502, headers: { 'content-type': 'text/html' } }),
      ),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/<html|<body|<h1/i);
  });

  it('keeps an HTML page answered with 200 out of the error too', async () => {
    http.route(
      createRoute(
        new Response(HTML_403, { status: 200, headers: { 'content-type': 'text/html' } }),
      ),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(JSON.stringify(result)).not.toMatch(/<html|<body|<h1/i);
  });
});

describe('bsky_search_posts — Bluesky refuses the search', () => {
  it('reports search_refused with a keyless recovery and no HTML anywhere', async () => {
    http.route(
      {
        method: 'POST',
        match: `${ENTRYWAY}/com.atproto.server.createSession`,
        respond: Response.json(session(1)),
      },
      {
        match: /\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
        respond: new Response(HTML_403, { status: 403, headers: { 'content-type': 'text/html' } }),
      },
    );

    const result = await runToolContract(bskySearchPosts, { query: 'weather' });

    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data?.reason).toBe('search_refused');
    expect(error.data?.recovery?.hint).toContain('bsky_get_feed');
    expect(JSON.stringify(result)).not.toMatch(/<html|<body|<h1/i);
    expect(textOf(result)).toContain(error.data?.recovery?.hint ?? '');
    expect(error.data?.recovery?.hint).toBe(
      bskySearchPosts.errors?.find((e) => e.reason === 'search_refused')?.recovery,
    );
    // A refusal is an answer, not a transient: one search request, no retry.
    expect(trail()).toEqual([CREATE, SEARCH]);
  });

  it("still quotes Bluesky's reason for a rejected filter through the authenticated path", async () => {
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(
        Response.json(
          {
            error: 'InvalidRequest',
            message: 'Invalid app.bsky.feed.searchPosts params: Invalid language (got "qq-")',
          },
          { status: 400 },
        ),
      ),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });
    const error = errorOf(result);
    expect(error.data?.reason).toBe('upstream_rejected_filter');
    expect(error.message).toContain('Invalid language');
    // A filter rejection is not a token rejection: nothing is renewed.
    expect(trail()).toEqual([CREATE, SEARCH]);
  });
});

describe('bsky_search_posts — the daily login limit', () => {
  const T0 = Date.parse('2026-09-25T12:00:00.000Z');
  const MINUTE = 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A 429 the way the entryway answers one, with its reset as epoch seconds when given. */
  const limited = (resetAtMs?: number) =>
    Response.json(
      { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' },
      {
        status: 429,
        headers: {
          'ratelimit-limit': '10',
          'ratelimit-remaining': '0',
          'ratelimit-policy': '10;w=86400',
          ...(resetAtMs === undefined ? {} : { 'ratelimit-reset': String(resetAtMs / 1000) }),
        },
      },
    );

  /** Asserts a search_login_limited envelope naming when to retry and the keyless route meanwhile. */
  function expectLimited(result: Awaited<ReturnType<typeof runToolContract>>, until: number) {
    expect(result.isError).toBe(true);
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('search_login_limited');
    const when = new Date(until).toISOString();
    expect(error.message).toContain(when);
    expect(error.data?.recovery?.hint).toContain(when);
    expect(error.data?.recovery?.hint).toContain('bsky_get_trending');
    expect(error.data?.recovery?.hint).toContain('bsky_get_feed');
    expect(textOf(result)).toContain(when);
    expect(JSON.stringify(result)).not.toMatch(/abcd-efgh|access-\d|refresh-\d/);
  }

  it('latches until ratelimit-reset, sending nothing meanwhile, then logs in again', async () => {
    const reset = T0 + 60 * MINUTE;
    http.route(
      createRoute(limited(reset)),
      createRoute(Response.json(session(1))),
      searchRoute(Response.json(searchBody)),
    );

    expectLimited(await runToolContract(bskySearchPosts, { query: 'x' }), reset);
    expect(trail()).toEqual([CREATE]);

    vi.setSystemTime(reset - 1000);
    expectLimited(await runToolContract(bskySearchPosts, { query: 'y' }), reset);
    expect(trail()).toEqual([CREATE]);

    vi.setSystemTime(reset + 1000);
    const after = await runToolContract(bskySearchPosts, { query: 'z' });
    expect(after.isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, CREATE, SEARCH]);
  });

  it('latches for 15 minutes when the 429 carries no ratelimit-reset', async () => {
    http.route(
      createRoute(limited()),
      createRoute(Response.json(session(1))),
      searchRoute(Response.json(searchBody)),
    );

    expectLimited(await runToolContract(bskySearchPosts, { query: 'x' }), T0 + 15 * MINUTE);

    vi.setSystemTime(T0 + 14 * MINUTE);
    expectLimited(await runToolContract(bskySearchPosts, { query: 'y' }), T0 + 15 * MINUTE);
    expect(trail()).toEqual([CREATE]);

    vi.setSystemTime(T0 + 15 * MINUTE + 1000);
    expect((await runToolContract(bskySearchPosts, { query: 'z' })).isError).toBeFalsy();
    expect(trail()).toEqual([CREATE, CREATE, SEARCH]);
  });

  it('hands concurrent first searches one shared limit error, naming no single request', async () => {
    const reset = T0 + 30 * MINUTE;
    http.route(createRoute(limited(reset)));

    const results = await Promise.all([
      runToolContract(bskySearchPosts, { query: 'a' }),
      runToolContract(bskySearchPosts, { query: 'b' }),
    ]);

    expect(trail()).toEqual([CREATE]);
    for (const result of results) {
      expectLimited(result, reset);
      expect(errorOf(result).data).not.toHaveProperty('requestId');
    }
  });

  it('latches on a limited refresh too, and keeps the session to refresh once it lifts', async () => {
    const reset = T0 + 20 * MINUTE;
    http.route(
      createRoute(Response.json(session(1))),
      searchRoute(expiredToken()),
      {
        method: 'POST',
        match: `${PDS}/xrpc/com.atproto.server.refreshSession`,
        once: true,
        respond: limited(reset),
      },
      searchRoute(expiredToken()),
      refreshRoute(Response.json(session(2))),
      searchRoute(Response.json(searchBody)),
    );

    expectLimited(await runToolContract(bskySearchPosts, { query: 'x' }), reset);
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH]);

    vi.setSystemTime(reset - 1000);
    expectLimited(await runToolContract(bskySearchPosts, { query: 'y' }), reset);
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH]);

    vi.setSystemTime(reset + 1000);
    expect((await runToolContract(bskySearchPosts, { query: 'z' })).isError).toBeFalsy();
    // No second login: the kept session is refreshed instead.
    expect(trail()).toEqual([CREATE, SEARCH, REFRESH, SEARCH, REFRESH, SEARCH]);
  });

  it('stays distinct from a rejected login, which never lifts', async () => {
    http.route(
      createRoute(limited(T0 + 5 * MINUTE)),
      createRoute(
        Response.json(
          { error: 'AuthenticationRequired', message: 'Invalid identifier or password' },
          { status: 401 },
        ),
      ),
    );

    expectLimited(await runToolContract(bskySearchPosts, { query: 'x' }), T0 + 5 * MINUTE);
    vi.setSystemTime(T0 + 6 * MINUTE);
    expectAuthFailed(await runToolContract(bskySearchPosts, { query: 'y' }));
    vi.setSystemTime(T0 + 24 * 60 * MINUTE);
    expectAuthFailed(await runToolContract(bskySearchPosts, { query: 'z' }));
    expect(trail()).toEqual([CREATE, CREATE]);
  });
});

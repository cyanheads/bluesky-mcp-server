/**
 * @fileoverview bsky_search_posts through the real service and search session over a faked global
 * `fetch`, asserting the exact query string that leaves for `app.bsky.feed.searchPosts` — the
 * language case and two-letter rule, the bare tag, the mention / domain / URL filters and their
 * rewrites — and the truncation and hit-count disclosure across a paged walk, on both surfaces.
 * Any request no test routed rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-search-posts.params.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const PDS = 'https://pds.example.test';
const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

const postView = (i: number) => ({
  uri: `at://did:plc:abc/app.bsky.feed.post/p${i}`,
  cid: `bafy${i}`,
  author: { did: 'did:plc:abc', handle: 'alice.bsky.social' },
  record: { text: `post ${i}` },
});

/** Search pages keyed by the cursor that requests them (`''` is the first page). */
type SearchPages = Record<string, { posts: number; cursor?: string; hitsTotal?: number }>;

/** Route one login, then answer every search from `pages`. */
function routeSearch(pages: SearchPages = { '': { posts: 1, hitsTotal: 1 } }) {
  http.route(
    {
      method: 'POST',
      match: 'https://bsky.social/xrpc/com.atproto.server.createSession',
      once: true,
      respond: () =>
        Response.json({
          accessJwt: 'access',
          refreshJwt: 'refresh',
          did: 'did:plc:operator',
          handle: 'operator.bsky.social',
          didDoc: {
            service: [
              { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
            ],
          },
        }),
    },
    {
      method: 'GET',
      match: /^https:\/\/pds\.example\.test\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
      respond: (request: Request) => {
        const page = pages[new URL(request.url).searchParams.get('cursor') ?? ''];
        if (!page) return Response.json({ error: 'InternalServerError' }, { status: 500 });
        return Response.json({
          posts: Array.from({ length: page.posts }, (_, i) => postView(i)),
          ...(page.cursor ? { cursor: page.cursor } : {}),
          ...(page.hitsTotal === undefined ? {} : { hitsTotal: page.hitsTotal }),
        });
      },
    },
  );
}

/** Query parameters of the one search request made. */
function sent(): URLSearchParams {
  const searches = http.calls.filter((c) => c.request.url.includes('app.bsky.feed.searchPosts'));
  expect(searches).toHaveLength(1);
  return new URL(searches[0]?.request.url ?? '').searchParams;
}

type ErrorEnvelope = { code: number; message: string; data?: { reason?: string } };
const errorOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: ErrorEnvelope }).error;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');
type Structured = {
  posts: unknown[];
  cursor?: string;
  hitsTotal?: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
  notice?: string;
};
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Structured;

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
});

afterEach(() => {
  http.restore();
});

describe('bsky_search_posts — the request as sent', () => {
  it('sends the query, sort, limit, and rewritten author', async () => {
    routeSearch();
    const result = await runToolContract(bskySearchPosts, {
      query: 'weather',
      author_handle: '@bsky.app',
      since: '2025-01-01',
      until: '2025-12-31T23:59:59Z',
    });

    expect(result.isError).toBeFalsy();
    const params = sent();
    expect(params.get('q')).toBe('weather');
    expect(params.get('sort')).toBe('latest');
    expect(params.get('limit')).toBe('25');
    expect(params.get('author')).toBe('bsky.app');
    expect(params.get('since')).toBe('2025-01-01');
    expect(params.get('until')).toBe('2025-12-31T23:59:59Z');
    for (const absent of ['lang', 'tag', 'mentions', 'domain', 'url', 'cursor']) {
      expect(params.has(absent)).toBe(false);
    }
  });
});

describe('bsky_search_posts — language', () => {
  it.each([
    ['a two-letter code', 'en', 'en'],
    ['an uppercase code', 'EN', 'en'],
    ['a mixed-case code', 'Ja', 'ja'],
    ['a region subtag', 'en-US', 'en-US'],
    ['an uppercase code with a region', 'PT-BR', 'pt-BR'],
    ['script and region subtags', 'zh-Hant-TW', 'zh-Hant-TW'],
    ['a variant subtag', 'en-GB-oed', 'en-GB-oed'],
  ])('sends %s with its primary subtag lowercased (%s → %s)', async (_label, language, lang) => {
    routeSearch();
    const result = await runToolContract(bskySearchPosts, { query: 'x', language });
    expect(result.isError).toBeFalsy();
    expect(sent().get('lang')).toBe(lang);
  });

  it.each([
    ['an unassigned three-letter code', 'qqq'],
    ['a language with no two-letter code', 'fil'],
    ['the three-letter form of a filterable language', 'eng'],
    ['Toki Pona', 'tok'],
    ['a three-letter code with a region', 'haw-US'],
    ['a grandfathered tag', 'i-klingon'],
  ])('rejects %s (%s) before any request, naming the two-letter rule', async (_label, language) => {
    const result = await runToolContract(bskySearchPosts, { query: 'x', language });

    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(textOf(result)).toMatch(/two-letter/);
    expect(http.calls).toHaveLength(0);
  });
});

describe('bsky_search_posts — tag', () => {
  it.each([
    ['bare', 'art'],
    ['with the # prefix', '#art'],
  ])('sends a %s tag without the # prefix', async (_label, tag) => {
    routeSearch();
    await runToolContract(bskySearchPosts, { query: 'x', tag });
    expect(sent().get('tag')).toBe('art');
  });

  it('omits a blank tag', async () => {
    routeSearch();
    await runToolContract(bskySearchPosts, { query: 'x', tag: '' });
    expect(sent().has('tag')).toBe(false);
  });

  it.each(['#', '##', ' '])(
    'rejects a tag with nothing after the # (%j) before any request, since it would filter nothing',
    async (tag) => {
      const result = await runToolContract(bskySearchPosts, { query: 'x', tag });
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(http.calls).toHaveLength(0);
    },
  );
});

describe('bsky_search_posts — mentions', () => {
  it.each([
    ['a handle', 'bsky.app', 'bsky.app'],
    ['a DID', DID, DID],
    ['@handle', '@bsky.app', 'bsky.app'],
    ['a profile URL', 'https://bsky.app/profile/bsky.app', 'bsky.app'],
    ['a profile URL naming a DID', `https://bsky.app/profile/${DID}/`, DID],
  ])('sends %s as the account it names', async (_label, mentions, expected) => {
    routeSearch();
    const result = await runToolContract(bskySearchPosts, { query: 'thanks', mentions });
    expect(result.isError).toBeFalsy();
    expect(sent().get('mentions')).toBe(expected);
  });

  it('omits a blank mentions', async () => {
    routeSearch();
    await runToolContract(bskySearchPosts, { query: 'thanks', mentions: '' });
    expect(sent().has('mentions')).toBe(false);
  });

  it.each([
    ['a bare name without a dot', 'alice'],
    ['a post URL', 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l'],
    ['@ before a DID', `@${DID}`],
  ])('rejects %s before any request', async (_label, mentions) => {
    const result = await runToolContract(bskySearchPosts, { query: 'x', mentions });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });
});

describe('bsky_search_posts — domain', () => {
  it.each([
    ['a bare hostname', 'github.com', 'github.com'],
    ['a www. hostname', 'www.github.com', 'github.com'],
    ['a www. hostname in capitals', 'WWW.YouTube.com', 'youtube.com'],
    ['a subdomain', 'docs.github.com', 'docs.github.com'],
    ['a domain whose only other label follows www', 'www.com', 'www.com'],
  ])('sends %s as %s', async (_label, domain, expected) => {
    routeSearch();
    const result = await runToolContract(bskySearchPosts, { query: 'release', domain });
    expect(result.isError).toBeFalsy();
    expect(sent().get('domain')).toBe(expected);
  });

  it.each([
    ['a scheme', 'https://github.com'],
    ['a path', 'github.com/cyanheads'],
    ['a port', 'github.com:443'],
    ['a single label', 'localhost'],
  ])('rejects a domain with %s before any request, naming url', async (_label, domain) => {
    const result = await runToolContract(bskySearchPosts, { query: 'x', domain });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(textOf(result)).toContain('url');
    expect(http.calls).toHaveLength(0);
  });
});

describe('bsky_search_posts — url', () => {
  it.each([
    'https://github.com/cyanheads/mcp-ts-core',
    'https://github.com/cyanheads/mcp-ts-core/',
    'http://example.com/a?b=1#c',
  ])('sends %s unchanged', async (url) => {
    routeSearch();
    const result = await runToolContract(bskySearchPosts, { query: 'mcp', url });
    expect(result.isError).toBeFalsy();
    expect(sent().get('url')).toBe(url);
  });

  it.each([
    ['no scheme', 'github.com/cyanheads/mcp-ts-core'],
    ['another scheme', 'ftp://example.com/file'],
    ['no host', 'https://'],
    ['a space in the host', 'https://exa mple.com/'],
  ])('rejects a url with %s before any request', async (_label, url) => {
    const result = await runToolContract(bskySearchPosts, { query: 'x', url });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });

  it('sends every filter together on one request', async () => {
    routeSearch();
    await runToolContract(bskySearchPosts, {
      query: 'release',
      mentions: '@bsky.app',
      domain: 'www.github.com',
      url: 'https://github.com/cyanheads/mcp-ts-core',
      tag: '#opensource',
      language: 'EN',
    });
    const params = sent();
    expect(params.get('mentions')).toBe('bsky.app');
    expect(params.get('domain')).toBe('github.com');
    expect(params.get('url')).toBe('https://github.com/cyanheads/mcp-ts-core');
    expect(params.get('tag')).toBe('opensource');
    expect(params.get('lang')).toBe('en');
  });
});

describe('bsky_search_posts — a cursor Bluesky cannot decode', () => {
  const session = (n: number) => ({
    accessJwt: `access-${n}`,
    refreshJwt: `refresh-${n}`,
    did: 'did:plc:operator',
    handle: 'operator.bsky.social',
    didDoc: {
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }],
    },
  });
  const create = () => ({
    method: 'POST',
    match: 'https://bsky.social/xrpc/com.atproto.server.createSession',
    once: true,
    respond: () => Response.json(session(1)),
  });
  const search = (respond: () => Response) => ({
    method: 'GET',
    match: /^https:\/\/pds\.example\.test\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
    once: true,
    respond,
  });
  /** What searchPosts answered a malformed cursor with, live: `garbage` and `!!!` alike. */
  const badCursor = () =>
    Response.json({ error: 'InvalidRequest', message: 'Invalid cursor format' }, { status: 400 });
  const searches = () =>
    http.calls.filter((c) => c.request.url.includes('app.bsky.feed.searchPosts'));

  it('fails as invalid_cursor after one search request, with the declared recovery on both surfaces', async () => {
    http.route(create(), search(badCursor));

    const result = await runToolContract(bskySearchPosts, { query: 'bluesky', cursor: 'garbage' });

    expect(searches()).toHaveLength(1);
    expect(result.isError).toBe(true);
    const error = errorOf(result) as ErrorEnvelope & {
      data?: { recovery?: { hint?: string } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_cursor');
    expect(error.message).toContain('HTTP 400');
    const declared = bskySearchPosts.errors?.find((e) => e.reason === 'invalid_cursor')?.recovery;
    expect(declared).toBeTruthy();
    expect(error.data?.recovery?.hint).toBe(declared);
    expect(textOf(result)).toContain(declared ?? '<missing>');
  });

  it('leaves a 400 without a cursor to the filter-rejection path', async () => {
    http.route(
      create(),
      search(() =>
        Response.json(
          { error: 'InvalidRequest', message: 'Invalid uri (got "github.com")' },
          { status: 400 },
        ),
      ),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x' });

    expect(errorOf(result).data?.reason).toBe('upstream_rejected_filter');
    expect(errorOf(result).message).toContain('Invalid uri');
  });

  it('leaves a cursored 400 that names another parameter to the filter-rejection path', async () => {
    http.route(
      create(),
      search(() =>
        Response.json(
          { error: 'InvalidRequest', message: 'Invalid datetime (got "2025-02-31")' },
          { status: 400 },
        ),
      ),
    );

    const result = await runToolContract(bskySearchPosts, {
      query: 'x',
      since: '2025-02-31',
      cursor: 'page-2',
    });

    expect(searches()).toHaveLength(1);
    expect(errorOf(result).data?.reason).toBe('upstream_rejected_filter');
    expect(errorOf(result).message).toContain('Invalid datetime');
    expect(textOf(result)).not.toContain('invalid_cursor');
  });

  it('still retries a 500 on a cursored search', async () => {
    http.route(
      create(),
      search(() => Response.json({ error: 'InternalServerError' }, { status: 500 })),
      search(() => Response.json({ posts: [postView(1)], hitsTotal: 1 })),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x', cursor: 'page-2' });

    expect(result.isError).toBeFalsy();
    expect(searches()).toHaveLength(2);
  }, 15_000);

  it('still renews an expired token on a cursored search instead of blaming the cursor', async () => {
    http.route(
      create(),
      search(() =>
        Response.json({ error: 'ExpiredToken', message: 'Token has expired' }, { status: 400 }),
      ),
      {
        method: 'POST',
        match: `${PDS}/xrpc/com.atproto.server.refreshSession`,
        once: true,
        respond: () => Response.json(session(2)),
      },
      search(() => Response.json({ posts: [postView(1)], hitsTotal: 1 })),
    );

    const result = await runToolContract(bskySearchPosts, { query: 'x', cursor: 'page-2' });

    expect(result.isError).toBeFalsy();
    expect(searches()).toHaveLength(2);
    expect(searches().map((c) => new URL(c.request.url).searchParams.get('cursor'))).toEqual([
      'page-2',
      'page-2',
    ]);
    expect(searches()[1]?.request.headers.get('authorization')).toBe('Bearer access-2');
  });
});

describe('bsky_search_posts — truncation keyed on the cursor, hitsTotal as an estimate', () => {
  /**
   * The measured shape of an authenticated walk: `hitsTotal` 1009 on every page, pages at `limit`
   * 100 that come back short with a cursor, and a last page with none — 952 posts retrievable in
   * all, so the count overstates what paging returns.
   */
  const pages: SearchPages = {
    '': { posts: 100, cursor: 'c2', hitsTotal: 1009 },
    c2: { posts: 88, cursor: 'c3', hitsTotal: 1009 },
    c3: { posts: 8, hitsTotal: 1009 },
  };

  it('page 1: a full page with a cursor is truncated, and the count renders as an upper bound', async () => {
    routeSearch(pages);
    const result = await runToolContract(bskySearchPosts, { query: 'sesquipedalian', limit: 100 });

    const out = structured(result);
    expect(out).toMatchObject({ hitsTotal: 1009, cursor: 'c2', truncated: true, shown: 100 });
    const text = textOf(result);
    expect(text).toContain('Up to 1,009 matching posts');
    expect(text).not.toContain('**1,009 total matches**');
    expect(text).toContain('More posts match');
  });

  it('page 2: a short page that still carries a cursor is truncated', async () => {
    routeSearch(pages);
    const result = await runToolContract(bskySearchPosts, {
      query: 'sesquipedalian',
      limit: 100,
      cursor: 'c2',
    });

    expect(sent().get('cursor')).toBe('c2');
    expect(structured(result)).toMatchObject({
      cursor: 'c3',
      truncated: true,
      shown: 88,
      cap: 100,
    });
    expect(textOf(result)).toContain('More posts match');
  });

  it('page 3: no cursor is the end, whatever hitsTotal says', async () => {
    routeSearch(pages);
    const result = await runToolContract(bskySearchPosts, {
      query: 'sesquipedalian',
      limit: 100,
      cursor: 'c3',
    });

    const out = structured(result);
    expect(out.posts).toHaveLength(8);
    expect(out.hitsTotal).toBe(1009);
    expect(out).not.toHaveProperty('cursor');
    expect(out).not.toHaveProperty('truncated');
    expect(textOf(result)).not.toContain('More posts match');
  });

  it('a cursor is truncation even when hitsTotal is no larger than the page', async () => {
    routeSearch({ '': { posts: 3, cursor: 'c2', hitsTotal: 3 } });
    const result = await runToolContract(bskySearchPosts, { query: 'x', limit: 3 });
    expect(structured(result)).toMatchObject({ truncated: true, shown: 3, cap: 3 });
  });

  it('an empty page that still carries a cursor renders the count and the cursor, and claims no miss', async () => {
    routeSearch({ '': { posts: 0, cursor: 'c2', hitsTotal: 3 } });
    const result = await runToolContract(bskySearchPosts, { query: 'x', limit: 1 });

    const out = structured(result);
    expect(out).toMatchObject({ cursor: 'c2', hitsTotal: 3, truncated: true, shown: 0 });
    expect(out.notice).toContain('More posts match');
    expect(out.notice).not.toContain('No posts matched');
    const text = textOf(result);
    expect(text).toContain('Up to 3 matching posts');
    expect(text).toContain('*cursor: `c2`*');
    expect(text).not.toContain('No posts matched');
  });

  it('keeps exactly 10,000 a lower bound', async () => {
    routeSearch({ '': { posts: 2, cursor: 'c2', hitsTotal: 10_000 } });
    const text = textOf(await runToolContract(bskySearchPosts, { query: 'the', limit: 2 }));
    expect(text).toContain('At least 10,000 total matches');
    expect(text).not.toContain('Up to 10,000');
  });
});

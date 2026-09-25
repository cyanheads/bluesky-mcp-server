/**
 * @fileoverview Tests for bsky_get_post_quotes through the real service over a faked global
 * `fetch`: handle resolution, the empty-page existence check, cursor paging to exhaustion, the
 * reduction of the restated queried post on quote, quote-with-media, and quote-of-quote shapes, and
 * the invalid-cursor mapping. Any request no test routed rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-get-post-quotes.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetPostQuotes } from '@/mcp-server/tools/definitions/bsky-get-post-quotes.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const RKEY = '3l6oveex3ii2l';
const TARGET = `at://${DID}/app.bsky.feed.post/${RKEY}`;
const TARGET_TEXT = 'THE QUOTED POST ITSELF, restated on every result';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});

afterEach(() => {
  http.restore();
});

// ---------------------------------------------------------------------------
// Upstream shapes
// ---------------------------------------------------------------------------

/** The target as the AppView restates it inside a quote: `app.bsky.embed.record#viewRecord`. */
const targetViewRecord = (embeds?: unknown[]) => ({
  $type: 'app.bsky.embed.record#viewRecord',
  uri: TARGET,
  cid: 'bafytarget',
  author: { did: DID, handle: 'bsky.app' },
  value: { text: TARGET_TEXT },
  ...(embeds ? { embeds } : {}),
});

/** A plain quote of the target. */
const quote = (rkey: string, extra: Record<string, unknown> = {}) => ({
  uri: `at://did:plc:quoter/app.bsky.feed.post/${rkey}`,
  cid: `bafy${rkey}`,
  author: { did: 'did:plc:quoter', handle: 'quoter.bsky.social' },
  record: { text: `commentary ${rkey}` },
  likeCount: 1,
  embed: { $type: 'app.bsky.embed.record#view', record: targetViewRecord() },
  ...extra,
});

const quotesPage = (posts: unknown[], cursor?: string) =>
  Response.json({ posts, uri: TARGET, ...(cursor ? { cursor } : {}) });

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
type Out = {
  uri: string;
  posts: Array<Record<string, unknown> & { embed?: Record<string, unknown> }>;
  cursor?: string;
  totalReturned: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
  notice?: string;
};
const structured = (result: { structuredContent?: unknown }) => result.structuredContent as Out;
const paths = () => http.calls.map((c) => new URL(c.request.url).pathname.replace('/xrpc/', ''));
const param = (i: number, name: string) =>
  new URL(http.calls[i]?.request.url ?? '').searchParams.get(name);

/** Asserts the declared reason, its recovery on both surfaces, and the request count. */
async function expectFailure(
  input: { uri: string; cursor?: string },
  reason: string,
  code: number,
) {
  const result = await runToolContract(bskyGetPostQuotes, input);
  expect(result.isError).toBe(true);
  const error = errorOf(result);
  expect(error.code).toBe(code);
  expect(error.data?.reason).toBe(reason);
  const declared = bskyGetPostQuotes.errors?.find((e) => e.reason === reason)?.recovery;
  expect(error.data?.recovery?.hint).toBe(declared);
  expect(textOf(result)).toContain(declared ?? '<missing>');
  return error;
}

// ---------------------------------------------------------------------------

describe('bsky_get_post_quotes — reading quotes', () => {
  it('reads a DID-authority post in one request, unauthenticated', async () => {
    http.route({ match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([quote('a')]) });

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });

    expect(result.isError).toBeFalsy();
    expect(paths()).toEqual(['app.bsky.feed.getQuotes']);
    expect(param(0, 'uri')).toBe(TARGET);
    expect(param(0, 'limit')).toBe('25');
    expect(http.calls[0]?.request.headers.has('authorization')).toBe(false);
    const out = structured(result);
    expect(out.uri).toBe(TARGET);
    expect(out.posts.map((p) => p.uri)).toEqual(['at://did:plc:quoter/app.bsky.feed.post/a']);
    expect(out.totalReturned).toBe(1);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    const text = textOf(result);
    expect(text).toContain(`## Quotes of \`${TARGET}\``);
    expect(text).toContain('> commentary a');
  });

  it('resolves a handle authority first, and returns what the DID form returns', async () => {
    http.route({ match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([quote('a')]) });
    const byDid = structured(await runToolContract(bskyGetPostQuotes, { uri: TARGET }));

    http.reset();
    http.route(
      {
        match: 'https://api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=bsky.app',
        respond: () => Response.json({ did: DID }),
      },
      { match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([quote('a')]) },
    );
    const byHandle = structured(
      await runToolContract(bskyGetPostQuotes, { uri: `at://bsky.app/app.bsky.feed.post/${RKEY}` }),
    );

    expect(paths()).toEqual(['com.atproto.identity.resolveHandle', 'app.bsky.feed.getQuotes']);
    expect(param(1, 'uri')).toBe(TARGET);
    expect(byHandle).toEqual(byDid);
  });

  it('forwards limit and cursor', async () => {
    http.route({ match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([quote('a')]) });
    await runToolContract(bskyGetPostQuotes, { uri: TARGET, limit: 100, cursor: 'c1' });
    expect(param(0, 'limit')).toBe('100');
    expect(param(0, 'cursor')).toBe('c1');
  });

  it('keeps a sparse quote post valid in both channels and invents nothing', async () => {
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () =>
        quotesPage([
          {
            uri: 'at://did:plc:q/app.bsky.feed.post/s',
            cid: 'bafys',
            author: { did: 'did:plc:q', handle: 'q.bsky.social' },
            record: { text: '' },
          },
        ]),
    });

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });
    expect(result.isError).toBeFalsy();
    expect(structured(result).posts).toEqual([
      {
        uri: 'at://did:plc:q/app.bsky.feed.post/s',
        cid: 'bafys',
        text: '',
        author: { did: 'did:plc:q', handle: 'q.bsky.social' },
      },
    ]);
    const text = textOf(result);
    expect(text).toContain('at://did:plc:q/app.bsky.feed.post/s');
    expect(text).not.toMatch(/likes|quotes ·|Created:|💬/);
  });
});

describe('bsky_get_post_quotes — paging', () => {
  it('follows short pages that carry cursors to exhaustion, truncated exactly when a cursor came back', async () => {
    const pages: Record<string, Response> = {
      '': quotesPage([quote('a'), quote('b')], 'c1'),
      c1: quotesPage([quote('c')], 'c2'),
      c2: quotesPage([]),
    };
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: (request: Request) =>
        (pages[new URL(request.url).searchParams.get('cursor') ?? ''] as Response).clone(),
    });

    const seen: string[] = [];
    const flags: Array<boolean | undefined> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const out = structured(
        await runToolContract(bskyGetPostQuotes, {
          uri: TARGET,
          limit: 5,
          ...(cursor ? { cursor } : {}),
        }),
      );
      seen.push(...out.posts.map((p) => String(p.uri).split('/').pop() ?? ''));
      flags.push(out.truncated);
      if (out.cursor) {
        expect(out).toMatchObject({ truncated: true, shown: out.posts.length, cap: 5 });
      } else {
        expect(out.notice).toBe('No more quotes — the previous page was the last.');
      }
      cursor = out.cursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(flags).toEqual([true, true, undefined]);
    /** An empty page reached through a cursor is the end, not a reason to check the post exists. */
    expect(paths()).toEqual(Array(3).fill('app.bsky.feed.getQuotes'));
  });

  it('renders the cursor in the text channel', async () => {
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () => quotesPage([quote('a')], '2025-08-20T01:37:31.068Z'),
    });
    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });
    expect(textOf(result)).toContain('*cursor: `2025-08-20T01:37:31.068Z`*');
  });

  it('renders the cursor in the text channel on an empty page that still carries one', async () => {
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () => quotesPage([], '2025-08-19T00:00:00.000Z'),
    });
    const result = await runToolContract(bskyGetPostQuotes, {
      uri: TARGET,
      cursor: '2025-08-20T01:37:31.068Z',
    });
    expect(structured(result)).toMatchObject({
      cursor: '2025-08-19T00:00:00.000Z',
      truncated: true,
    });
    expect(textOf(result)).toContain('*cursor: `2025-08-19T00:00:00.000Z`*');
  });
});

describe('bsky_get_post_quotes — an empty first page', () => {
  it('checks the post exists and reports a post nobody quoted with a notice', async () => {
    http.route(
      { match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([]) },
      {
        match: /app\.bsky\.feed\.getPosts/,
        respond: () => Response.json({ posts: [{ ...quote('t'), uri: TARGET, quoteCount: 0 }] }),
      },
    );

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });

    expect(result.isError).toBeFalsy();
    expect(paths()).toEqual(['app.bsky.feed.getQuotes', 'app.bsky.feed.getPosts']);
    expect(param(1, 'uris')).toBe(TARGET);
    const out = structured(result);
    expect(out.posts).toEqual([]);
    expect(out.notice).toBe(`${TARGET} has no quotes.`);
    expect(textOf(result)).toContain('No quote posts on this page.');
    expect(textOf(result)).toContain(`${TARGET} has no quotes.`);
  });

  it('names the count when Bluesky counts quotes it cannot return', async () => {
    http.route(
      { match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([]) },
      {
        match: /app\.bsky\.feed\.getPosts/,
        respond: () => Response.json({ posts: [{ ...quote('t'), uri: TARGET, quoteCount: 3 }] }),
      },
    );
    const out = structured(await runToolContract(bskyGetPostQuotes, { uri: TARGET }));
    expect(out.notice).toContain('quoteCount is 3');
  });

  it('fails an invented record key as post_not_found', async () => {
    http.route(
      { match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([]) },
      { match: /app\.bsky\.feed\.getPosts/, respond: () => Response.json({ posts: [] }) },
    );
    const error = await expectFailure(
      { uri: `at://${DID}/app.bsky.feed.post/3zzzzzzzzzzzz` },
      'post_not_found',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.message).toContain(`at://${DID}/app.bsky.feed.post/3zzzzzzzzzzzz`);
    expect(http.calls).toHaveLength(2);
  });

  it('fails an invented DID as post_not_found', async () => {
    http.route(
      { match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([]) },
      { match: /app\.bsky\.feed\.getPosts/, respond: () => Response.json({ posts: [] }) },
    );
    await expectFailure(
      { uri: `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/${RKEY}` },
      'post_not_found',
      JsonRpcErrorCode.NotFound,
    );
  });

  it('fails an unresolvable handle as post_not_found without asking for quotes', async () => {
    http.route({
      match: /com\.atproto\.identity\.resolveHandle/,
      respond: () => xrpcError(400, 'InvalidRequest', 'Unable to resolve handle'),
    });
    const error = await expectFailure(
      { uri: `at://no-such-handle.bsky.social/app.bsky.feed.post/${RKEY}` },
      'post_not_found',
      JsonRpcErrorCode.NotFound,
    );
    expect(error.message).toContain('no-such-handle.bsky.social');
    expect(paths()).toEqual(['com.atproto.identity.resolveHandle']);
  });
});

describe('bsky_get_post_quotes — the restated queried post', () => {
  it('reduces a plain quote of the target to its address in both channels', async () => {
    http.route({ match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([quote('a')]) });

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });

    expect(structured(result).posts[0]?.embed).toEqual({
      type: 'record',
      uri: TARGET,
      cid: 'bafytarget',
    });
    const text = textOf(result);
    expect(text).toContain(`💬 Quoted post: \`${TARGET}\` | CID: \`bafytarget\``);
    expect(text).not.toContain(TARGET_TEXT);
    expect(text).not.toContain('by @bsky.app');
  });

  it("keeps the quoting post's own media on a recordWithMedia quote, and drops the target's", async () => {
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () =>
        quotesPage([
          quote('m', {
            embed: {
              $type: 'app.bsky.embed.recordWithMedia#view',
              record: {
                record: targetViewRecord([
                  {
                    $type: 'app.bsky.embed.images#view',
                    images: [{ fullsize: 'https://cdn/target.jpg', alt: 'the target image' }],
                  },
                ]),
              },
              media: {
                $type: 'app.bsky.embed.images#view',
                images: [{ fullsize: 'https://cdn/mine.jpg', alt: 'my reaction' }],
              },
            },
          }),
        ]),
    });

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });

    expect(structured(result).posts[0]?.embed).toEqual({
      type: 'record',
      uri: TARGET,
      cid: 'bafytarget',
      media: { type: 'images', images: [{ url: 'https://cdn/mine.jpg', alt: 'my reaction' }] },
    });
    const text = textOf(result);
    expect(text).toContain('https://cdn/mine.jpg');
    expect(text).toContain('> my reaction');
    expect(text).not.toContain('https://cdn/target.jpg');
    expect(text).not.toContain(TARGET_TEXT);
  });

  it('drops the quote the target itself carries, two levels down, on a quote of a quote', async () => {
    const inner = {
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: 'at://did:plc:origin/app.bsky.feed.post/o',
        cid: 'bafyorigin',
        author: { did: 'did:plc:origin', handle: 'origin.bsky.social' },
        value: { text: 'the post the target quoted' },
      },
    };
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () =>
        quotesPage([
          quote('qq', {
            embed: { $type: 'app.bsky.embed.record#view', record: targetViewRecord([inner]) },
          }),
        ]),
    });

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });

    expect(structured(result).posts[0]?.embed).toEqual({
      type: 'record',
      uri: TARGET,
      cid: 'bafytarget',
    });
    const text = textOf(result);
    expect(text).not.toContain('the post the target quoted');
    expect(text).not.toContain('bafyorigin');
  });

  it('keeps recordKind when the target is unreadable', async () => {
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () =>
        quotesPage([
          quote('d', {
            embed: {
              $type: 'app.bsky.embed.record#view',
              record: { $type: 'app.bsky.embed.record#viewNotFound', uri: TARGET, notFound: true },
            },
          }),
        ]),
    });

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });
    expect(structured(result).posts[0]?.embed).toEqual({
      type: 'record',
      uri: TARGET,
      cid: '',
      recordKind: 'notFound',
    });
    expect(textOf(result)).toContain('Quoted post unavailable — deleted or never existed');
  });

  it('leaves an embed that points anywhere else whole', async () => {
    const elsewhere = {
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: 'at://did:plc:other/app.bsky.feed.post/x',
        cid: 'bafyother',
        author: { did: 'did:plc:other', handle: 'other.bsky.social' },
        value: { text: 'some other post' },
      },
    };
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () => quotesPage([quote('e', { embed: elsewhere })]),
    });

    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });
    expect(structured(result).posts[0]?.embed).toMatchObject({
      uri: 'at://did:plc:other/app.bsky.feed.post/x',
      text: 'some other post',
      authorHandle: 'other.bsky.social',
    });
    expect(textOf(result)).toContain('> some other post');
  });
});

describe('bsky_get_post_quotes — cursors', () => {
  it('fails a cursor Bluesky answers with 500 once, as invalid_cursor', async () => {
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: () => xrpcError(500, 'InternalServerError', 'Internal Server Error'),
    });
    await expectFailure(
      { uri: TARGET, cursor: 'garbage' },
      'invalid_cursor',
      JsonRpcErrorCode.ValidationError,
    );
    expect(http.calls).toHaveLength(1);
  });

  it('still retries a 500 on the first page', async () => {
    http.route(
      {
        match: /app\.bsky\.feed\.getQuotes/,
        once: true,
        respond: () => xrpcError(500, 'InternalServerError', 'Internal Server Error'),
      },
      { match: /app\.bsky\.feed\.getQuotes/, respond: () => quotesPage([quote('a')]) },
    );
    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET });
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  }, 15_000);
});

describe('bsky_get_post_quotes — input', () => {
  it.each([
    ['a feed generator AT-URI', `at://${DID}/app.bsky.feed.generator/whats-hot`],
    ['a profile record AT-URI', `at://${DID}/app.bsky.actor.profile/self`],
    ['a list AT-URI', `at://${DID}/app.bsky.graph.list/3lc4`],
    ['a post AT-URI with no record key', `at://${DID}/app.bsky.feed.post`],
    ['a feed URL', 'https://bsky.app/profile/bsky.app/feed/whats-hot'],
    ['a profile URL', 'https://bsky.app/profile/bsky.app'],
    ['a quotes page URL', `https://bsky.app/profile/bsky.app/post/${RKEY}/quotes`],
    ['a handle', 'bsky.app'],
  ])('rejects %s before any request', async (_label, uri) => {
    const result = await runToolContract(bskyGetPostQuotes, { uri });
    expect(result.isError).toBe(true);
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(textOf(result)).toContain('not a post');
    expect(http.calls).toHaveLength(0);
  });

  it.each([0, 101])('rejects limit %i at the schema', async (limit) => {
    const result = await runToolContract(bskyGetPostQuotes, { uri: TARGET, limit });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });

  it('defaults limit to 25 and accepts 100', () => {
    expect(bskyGetPostQuotes.input.parse({ uri: TARGET }).limit).toBe(25);
    expect(bskyGetPostQuotes.input.parse({ uri: TARGET, limit: 100 }).limit).toBe(100);
  });
});

describe('bsky_get_post_quotes — format()', () => {
  it('names the queried post on an empty page', () => {
    const [block] = bskyGetPostQuotes.format?.({ uri: TARGET, posts: [] }) ?? [];
    expect((block as { text: string }).text).toBe(
      `## Quotes of \`${TARGET}\`\n\nNo quote posts on this page.`,
    );
  });
});

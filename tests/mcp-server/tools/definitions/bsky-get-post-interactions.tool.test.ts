/**
 * @fileoverview Post interaction contracts through the real AppView HTTP boundary.
 * @module tests/mcp-server/tools/definitions/bsky-get-post-interactions.tool.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bskyGetPostInteractions } from '@/mcp-server/tools/definitions/bsky-get-post-interactions.tool.js';
import { getBlueskyService, initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const URI = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l';
const actor = {
  did: 'did:plc:alice',
  handle: 'alice.bsky.social',
  createdAt: '2020-01-01T00:00:00Z',
  labels: [{ val: 'spam', src: 'did:plc:labeler', cts: '2025-01-01T00:00:00Z' }],
};
const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});
const endpoint = (name: string) => (request: Request) => {
  const url = new URL(request.url);
  return url.origin === 'https://api.bsky.app' && url.pathname === `/xrpc/${name}`;
};
beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});
afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

it('characterizes the actor-summary metadata reused by interaction rows', async () => {
  http.route({
    match: endpoint('app.bsky.graph.getFollows'),
    respond: () =>
      Response.json({
        subject: actor,
        follows: [actor, { did: 'did:plc:sparse', handle: 'sparse.test' }],
      }),
  });
  const result = await getBlueskyService().getFollows({ actor: actor.did }, createMockContext());
  expect(result.actors).toEqual([actor, { did: 'did:plc:sparse', handle: 'sparse.test' }]);
});

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((block) => block.text ?? '').join('\n');
type Output = {
  uri: string;
  kind: 'likes' | 'reposts';
  actors: Array<Record<string, unknown>>;
  cursor?: string;
  notice?: string;
  totalReturned: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
};
const output = (result: { structuredContent?: unknown }) => result.structuredContent as Output;
const errorOf = (result: { structuredContent?: unknown }) =>
  (
    result.structuredContent as {
      error: {
        code: number;
        message: string;
        data: { reason?: string; recovery?: { hint?: string } };
      };
    }
  ).error;
const paths = () => http.calls.map((call) => new URL(call.request.url).pathname.split('/').pop());
const page = (kind: 'likes' | 'reposts', actors: unknown[], cursor?: string) =>
  Response.json({
    [kind === 'likes' ? 'likes' : 'repostedBy']:
      kind === 'likes'
        ? actors.map((value) => ({
            actor: value,
            createdAt: '2026-01-01T00:00:00Z',
            indexedAt: '2026-01-02T00:00:00Z',
          }))
        : actors,
    ...(cursor ? { cursor } : {}),
  });
const routePage = (kind: 'likes' | 'reposts', actors: unknown[], cursor?: string) =>
  http.route({
    match: endpoint(kind === 'likes' ? 'app.bsky.feed.getLikes' : 'app.bsky.feed.getRepostedBy'),
    respond: () => page(kind, actors, cursor),
  });
const existence = (exists: boolean) =>
  http.route({
    match: endpoint('app.bsky.feed.getPosts'),
    respond: () => Response.json({ posts: exists ? [{ uri: URI }] : [] }),
  });

it.each(['likes', 'reposts'] as const)(
  'reads %s in one unauthenticated request with sparse ordered actor metadata on both channels',
  async (kind) => {
    const rich = {
      ...actor,
      displayName: '*Alice*',
      description: 'bio\n## untrusted',
      pronouns: 'they/them',
      avatar: 'https://cdn.example/avatar.jpg',
      verification: { verifiedStatus: 'valid', trustedVerifierStatus: 'none', verifications: [] },
    };
    routePage(kind, [rich, { did: 'did:plc:sparse', handle: 'sparse.test' }]);
    const result = await runToolContract(bskyGetPostInteractions, { uri: URI, kind });
    expect(result.isError).toBeFalsy();
    const out = output(result);
    expect(out).toMatchObject({ uri: URI, kind, totalReturned: 2 });
    expect(out.actors).toEqual([
      {
        ...actor,
        displayName: '*Alice*',
        description: 'bio\n## untrusted',
        pronouns: 'they/them',
        avatar: 'https://cdn.example/avatar.jpg',
        verification: { verifiedStatus: 'valid', trustedVerifierStatus: 'none' },
        ...(kind === 'likes' ? { likedAt: '2026-01-01T00:00:00Z' } : {}),
      },
      {
        did: 'did:plc:sparse',
        handle: 'sparse.test',
        ...(kind === 'likes' ? { likedAt: '2026-01-01T00:00:00Z' } : {}),
      },
    ]);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('cap');
    const text = textOf(result);
    for (const value of [
      URI,
      kind,
      'alice.bsky.social',
      'did:plc:alice',
      'sparse.test',
      'did:plc:sparse',
      '2020-01-01T00:00:00Z',
      'spam',
      'did:plc:labeler',
      '2025-01-01T00:00:00Z',
      'they/them',
      'https://cdn.example/avatar.jpg',
      'valid',
      'none',
    ])
      expect(text).toContain(value);
    expect(text).toContain('**Joined:** 2020-01-01T00:00:00Z');
    expect(text).toContain('> bio\n> \\## untrusted');
    expect(text).toContain('\\*Alice\\*');
    if (kind === 'likes') expect(text).toContain('**Liked:** 2026-01-01T00:00:00Z');
    else expect(text).not.toContain('Liked:');
    expect(text).toContain(out.notice);
    expect(http.calls).toHaveLength(1);
    const request = http.calls[0]!.request;
    expect(request.headers.has('authorization')).toBe(false);
    expect(new URL(request.url).searchParams.get('limit')).toBe('25');
  },
);

it.each(['likes', 'reposts'] as const)(
  'walks %s short first/second/empty continuation pages with exact cursor disclosures',
  async (kind) => {
    const name = kind === 'likes' ? 'app.bsky.feed.getLikes' : 'app.bsky.feed.getRepostedBy';
    http.route({
      match: endpoint(name),
      respond: (request) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        return cursor === 'two'
          ? page(kind, [])
          : cursor === 'one'
            ? page(kind, [{ did: 'did:plc:second', handle: 'second.test' }], 'two')
            : page(kind, [actor], 'one');
      },
    });
    const first = await runToolContract(bskyGetPostInteractions, { uri: URI, kind, limit: 150 });
    expect(output(first)).toMatchObject({ truncated: true, shown: 1, cap: 100, cursor: 'one' });
    expect(output(first).notice).toContain('limit 150 requested; 100 applied.');
    expect(textOf(first)).toContain(output(first).notice);
    expect(textOf(first)).toContain('*cursor: `one`*');
    const second = await runToolContract(bskyGetPostInteractions, {
      uri: URI,
      kind,
      cursor: 'one',
      limit: 100,
    });
    expect(output(second).actors[0]?.did).toBe('did:plc:second');
    expect(output(second)).toMatchObject({ truncated: true, shown: 1, cap: 100, cursor: 'two' });
    const last = await runToolContract(bskyGetPostInteractions, { uri: URI, kind, cursor: 'two' });
    expect(output(last).actors).toEqual([]);
    expect(output(last)).not.toHaveProperty('truncated');
    expect(output(last).notice).toContain('No more accounts');
    expect(textOf(last)).toContain(output(last).notice);
    expect(paths()).toEqual([name, name, name]);
  },
);

it.each(['likes', 'reposts'] as const)(
  'checks existence only on an empty first %s page',
  async (kind) => {
    routePage(kind, []);
    existence(true);
    const result = await runToolContract(bskyGetPostInteractions, { uri: URI, kind });
    expect(result.isError).toBeFalsy();
    expect(output(result).notice).toContain(`No readable ${kind}`);
    expect(textOf(result)).toContain(output(result).notice);
    expect(paths()).toEqual([
      kind === 'likes' ? 'app.bsky.feed.getLikes' : 'app.bsky.feed.getRepostedBy',
      'app.bsky.feed.getPosts',
    ]);
  },
);

it.each(['likes', 'reposts'] as const)(
  'reports a missing empty %s target with declared recovery on both channels',
  async (kind) => {
    routePage(kind, []);
    existence(false);
    const result = await runToolContract(bskyGetPostInteractions, { uri: URI, kind });
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'post_not_found' },
    });
    const hint = bskyGetPostInteractions.errors!.find(
      (entry) => entry.reason === 'post_not_found',
    )!.recovery;
    expect(errorOf(result).data.recovery?.hint).toBe(hint);
    expect(textOf(result)).toContain(hint);
  },
);

it('maps a malformed like cursor once with declared recovery and never checks existence', async () => {
  http.route({
    match: endpoint('app.bsky.feed.getLikes'),
    respond: () =>
      Response.json(
        { error: 'InternalServerError', message: 'Internal Server Error' },
        { status: 500 },
      ),
  });
  const result = await runToolContract(bskyGetPostInteractions, {
    uri: URI,
    kind: 'likes',
    cursor: 'bad',
  });
  expect(errorOf(result)).toMatchObject({
    code: JsonRpcErrorCode.ValidationError,
    data: { reason: 'invalid_cursor' },
  });
  expect(textOf(result)).toContain(errorOf(result).data.recovery?.hint);
  expect(http.calls).toHaveLength(1);
});

it('preserves an ignored repost cursor and repeated provider page', async () => {
  routePage('reposts', [actor], 'next');
  const first = await runToolContract(bskyGetPostInteractions, { uri: URI, kind: 'reposts' });
  const repeated = await runToolContract(bskyGetPostInteractions, {
    uri: URI,
    kind: 'reposts',
    cursor: 'bad',
  });
  expect(output(repeated)).toEqual(output(first));
  expect(http.calls).toHaveLength(2);
});

it.each([false, true])(
  'checks an ambiguous first repost500 (existing %s) and preserves failure when existing',
  async (exists) => {
    vi.useFakeTimers();
    http.route({
      match: endpoint('app.bsky.feed.getRepostedBy'),
      respond: () =>
        Response.json(
          { error: 'InternalServerError', message: 'Internal Server Error' },
          { status: 500 },
        ),
    });
    existence(exists);
    const pending = runToolContract(bskyGetPostInteractions, { uri: URI, kind: 'reposts' });
    await vi.runAllTimersAsync();
    const result = await pending;
    if (exists) {
      expect(errorOf(result).data.reason).not.toBe('post_not_found');
      expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    } else expect(errorOf(result).data.reason).toBe('post_not_found');
    expect(paths()).toEqual([
      ...Array(4).fill('app.bsky.feed.getRepostedBy'),
      'app.bsky.feed.getPosts',
    ]);
  },
);

it('resolves URL handle authority and preserves slash/query/fragment tolerance', async () => {
  http.route({
    match: endpoint('com.atproto.identity.resolveHandle'),
    respond: () => Response.json({ did: 'did:plc:z72i7hdynmk6r22z27h6tvur' }),
  });
  routePage('likes', [actor]);
  const result = await runToolContract(bskyGetPostInteractions, {
    uri: 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l/?ref=x#fragment',
    kind: 'likes',
  });
  expect(output(result).uri).toBe(URI);
  expect(new URL(http.calls[1]!.request.url).searchParams.get('uri')).toBe(URI);
  expect(paths()).toEqual(['com.atproto.identity.resolveHandle', 'app.bsky.feed.getLikes']);
});

it('maps unresolvable handles without requesting interactions', async () => {
  http.route({
    match: endpoint('com.atproto.identity.resolveHandle'),
    respond: () =>
      Response.json(
        { error: 'InvalidRequest', message: 'Unable to resolve handle' },
        { status: 400 },
      ),
  });
  const result = await runToolContract(bskyGetPostInteractions, {
    uri: 'at://missing.test/app.bsky.feed.post/key',
    kind: 'reposts',
  });
  expect(errorOf(result).data.reason).toBe('post_not_found');
  expect(paths()).toEqual(['com.atproto.identity.resolveHandle']);
});

it.each([
  { uri: 'at://did:plc:alice/app.bsky.feed.generator/key', kind: 'likes' },
  { uri: URI, kind: 'quotes' },
  { uri: URI, kind: 'likes', limit: 0 },
  { uri: URI, kind: 'likes', limit: 1.5 },
  { uri: 'bad', kind: 'likes' },
])('rejects invalid arguments before any requests: %j', async (input) => {
  const runRaw = runToolContract<Parameters<typeof runToolContract>[0]>;
  const result = await runRaw(bskyGetPostInteractions, input);
  expect(errorOf(result)).toMatchObject({
    code: JsonRpcErrorCode.InvalidParams,
    data: { reason: 'invalid_arguments' },
  });
  expect(http.calls).toHaveLength(0);
});

it('preserves a cursor even on an empty page and derives truncation from it alone', async () => {
  routePage('likes', [], 'next');
  const result = await runToolContract(bskyGetPostInteractions, {
    uri: URI,
    kind: 'likes',
    cursor: 'previous',
  });
  expect(output(result)).toMatchObject({
    actors: [],
    cursor: 'next',
    truncated: true,
    shown: 0,
    cap: 25,
  });
  expect(textOf(result)).toContain('*cursor: `next`*');
  expect(http.calls).toHaveLength(1);
});

it('preserves cancellation during the existence fallback', async () => {
  const controller = new AbortController();
  const reason = new DOMException('cancel interaction existence', 'AbortError');
  routePage('likes', []);
  http.route({
    match: endpoint('app.bsky.feed.getPosts'),
    respond: () => {
      controller.abort(reason);
      return Promise.reject(reason);
    },
  });
  await expect(
    getBlueskyService().getPostInteractions(
      { uri: URI, kind: 'likes' },
      createMockContext({ signal: controller.signal }),
    ),
  ).rejects.toBe(reason);
  expect(paths()).toEqual(['app.bsky.feed.getLikes', 'app.bsky.feed.getPosts']);
});

it('shares the total deadline across handle resolution, page read, and existence fallback', async () => {
  vi.useFakeTimers();
  const start = Date.now();
  http.route(
    {
      match: endpoint('com.atproto.identity.resolveHandle'),
      respond: () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () => resolve(Response.json({ did: 'did:plc:z72i7hdynmk6r22z27h6tvur' })),
            9_000,
          ),
        ),
    },
    {
      match: endpoint('app.bsky.feed.getLikes'),
      respond: () =>
        new Promise<Response>((resolve) => setTimeout(() => resolve(page('likes', [])), 4_000)),
    },
    {
      match: endpoint('app.bsky.feed.getPosts'),
      respond: (request) =>
        new Promise<Response>((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    },
  );
  const pending = runToolContract(bskyGetPostInteractions, {
    uri: 'at://bsky.app/app.bsky.feed.post/3l6oveex3ii2l',
    kind: 'likes',
  });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(paths()).toEqual([
    'com.atproto.identity.resolveHandle',
    'app.bsky.feed.getLikes',
    'app.bsky.feed.getPosts',
  ]);
  expect(http.calls[2]!.request.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(errorOf(result).code).toBe(JsonRpcErrorCode.Timeout);
  expect(errorOf(result).message).toContain('15000ms');
  expect(http.calls[2]!.request.signal.aborted).toBe(true);
  expect(Date.now() - start).toBe(15_000);
});

it('strict limits reject 101 and retain in-range numeric-string repair', async () => {
  vi.stubEnv('BLUESKY_CLAMP_READ_LIMITS', 'false');
  vi.resetModules();
  try {
    const { bskyGetPostInteractions: strict } = await import(
      '@/mcp-server/tools/definitions/bsky-get-post-interactions.tool.js'
    );
    const service = await import('@/services/bluesky/bluesky-service.js');
    service.initBlueskyService();
    const runRaw = runToolContract<Parameters<typeof runToolContract>[0]>;
    const invalid = await runRaw(strict, { uri: URI, kind: 'likes', limit: '101' });
    expect(errorOf(invalid).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
    routePage('likes', [actor]);
    const valid = await runRaw(strict, { uri: URI, kind: 'likes', limit: '100' });
    expect(valid.isError).toBeFalsy();
    expect(new URL(http.calls[0]!.request.url).searchParams.get('limit')).toBe('100');
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
});

/**
 * @fileoverview Collection tool contracts through the real AppView request and projection code.
 * @module tests/mcp-server/tools/definitions/bsky-get-list.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyGetList } from '@/mcp-server/tools/definitions/bsky-get-list.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const DID = 'did:plc:eclio37ymobqex2ncko63h4r';
const LIST = `at://${DID}/app.bsky.graph.list/3lbugqe62cm2n`;
const PACK = `at://${DID}/app.bsky.graph.starterpack/3lbugqemf5427`;
const FIRST_FEED = `at://${DID}/app.bsky.feed.generator/news`;
const SECOND_FEED = `at://${DID}/app.bsky.feed.generator/world`;
const owner = { did: DID, handle: 'nytimes.com', displayName: '' };
const list = {
  uri: LIST,
  name: 'Reporting list',
  creator: owner,
  purpose: 'app.bsky.graph.defs#new-purpose',
  description: '',
  listItemCount: 0,
};
const pack = { uri: PACK, creator: owner, record: { name: 'NYT starter pack', list: LIST } };
const member = (key: string) => ({
  uri: `at://${DID}/app.bsky.graph.listitem/${key}`,
  subject: { did: `did:plc:${key}`, handle: `${key}.bsky.social` },
});

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});
const endpoint = (lexicon: string) => (request: Request) => {
  const url = new URL(request.url);
  return url.origin === 'https://api.bsky.app' && url.pathname === `/xrpc/${lexicon}`;
};
const route = (lexicon: string, respond: () => Response, once = false) =>
  http.route({ match: endpoint(lexicon), respond, once });
const xrpcError = (message: string, status = 400, error = 'InvalidRequest') =>
  Response.json({ error, message }, { status });
const requests = () => http.calls.map(({ request }) => new URL(request.url));
/** A last route on the AppView origin, so a request no test expected is recorded too. */
const recordStrays = () =>
  http.route({
    match: (request) => new URL(request.url).origin === 'https://api.bsky.app',
    respond: () => xrpcError('No route for this request', 418, 'Unrouted'),
  });
const output = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? '').join('\n');

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
});

afterEach(() => {
  http.restore();
  vi.restoreAllMocks();
});

describe('bsky_get_list direct detail', () => {
  it('resolves a list owner and pages members using the opaque cursor, without expanding identities', async () => {
    route('com.atproto.identity.resolveHandle', () => Response.json({ did: DID }));
    route(
      'app.bsky.graph.getList',
      () =>
        Response.json({
          list,
          items: [
            {
              ...member('first'),
              subject: { ...member('first').subject, description: 'unprojected' },
            },
          ],
          cursor: 'next/&=opaque',
        }),
      true,
    );
    route('app.bsky.graph.getList', () => Response.json({ list, items: [member('second')] }));
    const page = await runToolContract(bskyGetList, {
      list: 'https://bsky.app/profile/NYTimes.COM/lists/3lbugqe62cm2n/?ref=share',
      limit: 1,
    });
    expect(page.isError).toBeFalsy();
    expect(output(page)).toMatchObject({
      list,
      members: [member('first')],
      cursor: 'next/&=opaque',
      truncated: true,
      shown: 1,
      cap: 1,
    });
    expect(output(page).members).toEqual([member('first')]);
    expect(text(page)).toContain('**Reported member count:** 0');
    expect(text(page)).toContain('**Description (JSON string):**\n> ""');
    expect(text(page)).toContain('next/&amp;=opaque');
    const next = await runToolContract(bskyGetList, {
      list: LIST,
      limit: 1,
      cursor: 'next/&=opaque',
    });
    expect(next.isError).toBeFalsy();
    expect(output(next)).toEqual({ list, members: [member('second')], totalReturned: 1 });
    expect(text(next)).toContain('second.bsky.social');
    expect(requests().map((url) => [url.pathname, Object.fromEntries(url.searchParams)])).toEqual([
      ['/xrpc/com.atproto.identity.resolveHandle', { handle: 'nytimes.com' }],
      ['/xrpc/app.bsky.graph.getList', { list: LIST, limit: '1' }],
      ['/xrpc/app.bsky.graph.getList', { list: LIST, limit: '1', cursor: 'next/&=opaque' }],
    ]);
    expect(http.calls.every(({ request }) => !request.headers.has('authorization'))).toBe(true);
  });

  it('keeps pack metadata separate, follows record.list without hydration, and returns record feed references', async () => {
    route('app.bsky.graph.getStarterPack', () =>
      Response.json({
        starterPack: {
          ...pack,
          record: {
            ...pack.record,
            description: 'Pack introduction',
            feeds: [{ uri: FIRST_FEED }],
          },
          joinedWeekCount: 0,
          joinedAllTimeCount: 8,
          listItemsSample: [member('sample')],
        },
      }),
    );
    route('app.bsky.graph.getList', () => Response.json({ list, items: [member('paged')] }));
    const result = await runToolContract(bskyGetList, {
      list: `https://bsky.app/starter-pack/${DID}/3lbugqemf5427#share`,
      cursor: 'pack-page-2',
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({
      starterPack: {
        uri: PACK,
        listUri: LIST,
        name: 'NYT starter pack',
        creator: owner,
        description: 'Pack introduction',
        joinedWeekCount: 0,
        joinedAllTimeCount: 8,
        feeds: [{ feedUri: FIRST_FEED }],
      },
      list,
      members: [member('paged')],
      totalReturned: 1,
    });
    const rendered = text(result);
    expect(rendered).toContain('**Joins this week:** 0');
    expect(rendered).toContain('**All-time joins:** 8');
    expect(rendered).toContain('> Pack introduction');
    expect(rendered).toContain('> Reporting list');
    expect(rendered).toContain(FIRST_FEED);
    expect(rendered).toContain('paged.bsky.social');
    expect(requests().map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { starterPack: PACK },
      { list: LIST, limit: '1', cursor: 'pack-page-2' },
    ]);
  });

  it('returns available pack metadata with an explicit notice when the backing list is missing', async () => {
    route('app.bsky.graph.getStarterPack', () =>
      Response.json({
        starterPack: { ...pack, feeds: [], list: { uri: LIST } },
      }),
    );
    route('app.bsky.graph.getList', () => xrpcError('List not found'));
    const result = await runToolContract(bskyGetList, { list: PACK });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({
      starterPack: {
        uri: PACK,
        name: 'NYT starter pack',
        creator: owner,
        listUri: LIST,
        feeds: [],
      },
      notice:
        'Starter pack membership is unavailable because Bluesky could not find its backing list.',
    });
    expect(text(result)).toContain('**Feeds:** (empty)');
    expect(text(result)).toContain(
      'Starter pack membership is unavailable because Bluesky could not find its backing list.',
    );
    expect(text(result)).not.toContain('No members on this page.');
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    [
      'a backing list Bluesky could not find',
      () => {
        route('app.bsky.graph.getStarterPack', () => Response.json({ starterPack: pack }));
        route('app.bsky.graph.getList', () => xrpcError('List not found'));
      },
      { uri: PACK, name: 'NYT starter pack', creator: owner, listUri: LIST },
      'Starter pack membership is unavailable because Bluesky could not find its backing list.',
    ],
    [
      'a backing list reference that is not a list AT-URI',
      () =>
        route('app.bsky.graph.getStarterPack', () =>
          Response.json({
            starterPack: { ...pack, record: { ...pack.record, list: 'at://did:web:example/x/y' } },
          }),
        ),
      { uri: PACK, name: 'NYT starter pack', creator: owner, listUri: 'at://did:web:example/x/y' },
      'Starter pack membership is unavailable because its backing list reference could not be read.',
    ],
  ])(
    'puts the clamp notice ahead of the reason membership is unavailable for %s',
    async (_label, serve, starterPack, reason) => {
      serve();
      const result = await runToolContract(bskyGetList, { list: PACK, limit: 150 });
      const notice = `limit 150 requested; 100 applied. ${reason}`;
      expect(result.isError).toBeFalsy();
      expect(output(result)).toEqual({ starterPack, notice });
      expect(text(result)).toContain(notice);
    },
  );

  it('does not degrade a generic 400 from the backing list to unavailable membership', async () => {
    route('app.bsky.graph.getStarterPack', () => Response.json({ starterPack: pack }));
    route('app.bsky.graph.getList', () => xrpcError('Invalid request'));
    const result = await runToolContract(bskyGetList, { list: PACK, cursor: 'rejected' });
    expect(result.isError).toBe(true);
    expect(output(result)).toHaveProperty('error.code', JsonRpcErrorCode.InvalidParams);
    expect(output(result)).not.toHaveProperty('error.data.reason', 'list_not_found');
    expect(http.calls).toHaveLength(2);
  });

  it('preserves a transient backing-list failure with its retry information', async () => {
    route('app.bsky.graph.getStarterPack', () => Response.json({ starterPack: pack }));
    route('app.bsky.graph.getList', () =>
      Response.json(
        { error: 'InternalServerError', message: 'Internal Server Error' },
        { status: 500, headers: { 'Retry-After': '31' } },
      ),
    );
    const result = await runToolContract(bskyGetList, { list: PACK });
    expect(result.isError).toBe(true);
    expect(output(result)).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { status: 500 } },
    });
    expect(output(result)).not.toHaveProperty('starterPack');
    expect(text(result)).not.toContain('membership is unavailable');
    expect(http.calls).toHaveLength(2);
  });

  it('preserves caller cancellation during the pack request and does not fetch membership', async () => {
    const caller = new AbortController();
    route('app.bsky.graph.getStarterPack', () => {
      caller.abort();
      return Response.json({ starterPack: pack });
    });
    const result = await runToolContract(
      bskyGetList,
      { list: PACK },
      { context: { signal: caller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(output(result)).toHaveProperty('error.code', JsonRpcErrorCode.RequestCancelled);
    expect(text(result)).toMatch(/aborted|cancel/i);
    expect(http.calls).toHaveLength(1);
  });

  it('shares the deadline across pack and backing list requests', async () => {
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    route('app.bsky.graph.getStarterPack', () => {
      clock.mockReturnValue(start + 46_000);
      return Response.json({ starterPack: pack });
    });
    const result = await runToolContract(bskyGetList, { list: PACK });
    expect(result.isError).toBe(true);
    expect(output(result)).toHaveProperty('error.code', JsonRpcErrorCode.Timeout);
    expect(http.calls).toHaveLength(1);
  });
});

describe('bsky_get_list discovery', () => {
  it('preserves two empty intermediate list pages and keeps discovery in the same collection stream', async () => {
    for (const body of [
      { lists: [], cursor: 'p2' },
      { lists: [], cursor: 'p3' },
      { lists: [list] },
    ]) {
      route('app.bsky.graph.getLists', () => Response.json(body), true);
    }
    for (const [cursor, expected] of [
      [undefined, { lists: [], cursor: 'p2', shown: 0, cap: 1, truncated: true }],
      ['p2', { lists: [], cursor: 'p3', shown: 0, cap: 1, truncated: true }],
      ['p3', { lists: [list] }],
    ] as const) {
      const result = await runToolContract(bskyGetList, {
        actor: '@NYTimes.COM',
        kind: 'lists',
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.isError).toBeFalsy();
      expect(output(result)).toMatchObject(expected);
      expect(output(result)).not.toHaveProperty('starterPacks');
      expect(text(result)).toContain(
        expected.lists.length ? 'Reporting list' : 'No lists on this page.',
      );
      if ('cursor' in expected) expect(text(result)).toContain(`**Cursor:** "${expected.cursor}"`);
    }
    expect(requests().map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { actor: 'nytimes.com', limit: '1' },
      { actor: 'nytimes.com', limit: '1', cursor: 'p2' },
      { actor: 'nytimes.com', limit: '1', cursor: 'p3' },
    ]);
  });

  it('keeps starter pack discovery sparse and composes a clamped past-the-end page', async () => {
    route(
      'app.bsky.graph.getActorStarterPacks',
      () =>
        Response.json({
          starterPacks: [
            {
              ...pack,
              record: { ...pack.record, feeds: [{ uri: FIRST_FEED }] },
              feeds: [{ uri: SECOND_FEED }, { uri: FIRST_FEED }],
            },
          ],
          cursor: 'p2',
        }),
      true,
    );
    route('app.bsky.graph.getActorStarterPacks', () => Response.json({ starterPacks: [] }));
    const initial = await runToolContract(bskyGetList, {
      actor: 'https://bsky.app/profile/nytimes.com',
      kind: 'starterPacks',
      limit: 100,
    });
    expect(output(initial)).toMatchObject({
      starterPacks: [
        {
          uri: PACK,
          name: 'NYT starter pack',
          creator: owner,
          listUri: LIST,
          feeds: [{ feedUri: FIRST_FEED }, { feedUri: SECOND_FEED }],
        },
      ],
      cursor: 'p2',
      shown: 1,
      cap: 100,
      truncated: true,
    });
    expect(output(initial)).not.toHaveProperty('starterPacks.0.joinedWeekCount');
    expect(text(initial)).toContain(FIRST_FEED);
    expect(text(initial)).toContain(SECOND_FEED);
    const next = await runToolContract(bskyGetList, {
      actor: 'nytimes.com',
      kind: 'starterPacks',
      cursor: 'p2',
      limit: 150,
    });
    expect(output(next)).toEqual({
      starterPacks: [],
      totalReturned: 0,
      notice:
        'limit 150 requested; 100 applied. No more starter packs — the previous page was the last.',
    });
    expect(text(next)).toContain('No starter packs on this page.');
    expect(text(next)).toContain(
      'limit 150 requested; 100 applied. No more starter packs — the previous page was the last.',
    );
    expect(requests().map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { actor: 'nytimes.com', limit: '100' },
      { actor: 'nytimes.com', limit: '100', cursor: 'p2' },
    ]);
  });
});

const members = (count: number) => Array.from({ length: count }, (_, i) => member(`m${i}`));
const withCursor = (cursor: string | undefined) => (cursor === undefined ? {} : { cursor });

/** Each read, how to serve one page of it, and the words its page notices use for it. */
const PAGE_READS = [
  {
    read: 'a list',
    input: { list: LIST },
    serve: (count: number, cursor?: string) =>
      route('app.bsky.graph.getList', () =>
        Response.json({ list, items: members(count), ...withCursor(cursor) }),
      ),
    target: 'list',
    noun: 'members',
    none: 'No members found on this list.',
  },
  {
    read: 'a starter pack',
    input: { list: PACK },
    serve: (count: number, cursor?: string) => {
      route('app.bsky.graph.getStarterPack', () => Response.json({ starterPack: pack }));
      route('app.bsky.graph.getList', () =>
        Response.json({ list, items: members(count), ...withCursor(cursor) }),
      );
    },
    target: 'starter pack',
    noun: 'members',
    none: 'No members found on this starter pack’s list.',
  },
  {
    read: 'an actor’s lists',
    input: { actor: 'nytimes.com', kind: 'lists' },
    serve: (count: number, cursor?: string) =>
      route('app.bsky.graph.getLists', () =>
        Response.json({ lists: Array.from({ length: count }, () => list), ...withCursor(cursor) }),
      ),
    target: 'actor and kind',
    noun: 'lists',
    none: 'No lists found for actor "nytimes.com".',
  },
  {
    read: 'an actor’s starter packs',
    input: { actor: '@NYTimes.COM', kind: 'starterPacks' },
    serve: (count: number, cursor?: string) =>
      route('app.bsky.graph.getActorStarterPacks', () =>
        Response.json({
          starterPacks: Array.from({ length: count }, () => pack),
          ...withCursor(cursor),
        }),
      ),
    target: 'actor and kind',
    noun: 'starter packs',
    none: 'No starter packs found for actor "NYTimes.COM".',
  },
] as const;

const FRAMEWORK_DEFAULT = 'Raise the cap or narrow with filters.';

describe.each(PAGE_READS)(
  'bsky_get_list page notices — $read',
  ({ input, serve, target, noun, none }) => {
    const follow = `Pass the returned cursor with the same ${target} to fetch the next page of ${noun}, even after an empty page.`;
    const last = `No more ${noun} — the previous page was the last.`;

    it('tells a page with a cursor to follow it, and counts what the page held', async () => {
      serve(2, 'next');
      const result = await runToolContract(bskyGetList, { ...input, limit: 2 });
      expect(result.isError).toBeFalsy();
      expect(output(result)).toMatchObject({
        cursor: 'next',
        totalReturned: 2,
        truncated: true,
        shown: 2,
        cap: 2,
        notice: follow,
      });
      expect(text(result)).toContain(follow);
      expect(text(result)).not.toContain(FRAMEWORK_DEFAULT);
    });

    it('keeps the clamp notice ahead of the cursor notice on both surfaces', async () => {
      serve(1, 'next');
      const result = await runToolContract(bskyGetList, { ...input, limit: 150 });
      const clamp = 'limit 150 requested; 100 applied.';
      expect(output(result)).toMatchObject({
        totalReturned: 1,
        truncated: true,
        cap: 100,
        notice: `${clamp} ${follow}`,
      });
      const rendered = text(result);
      expect(rendered).toContain(clamp);
      expect(rendered.indexOf(clamp)).toBeLessThan(rendered.indexOf(follow));
      expect(rendered).not.toContain(FRAMEWORK_DEFAULT);
    });

    it('treats an empty page that still carries a cursor as a page to follow, not the end', async () => {
      serve(0, 'next');
      const result = await runToolContract(bskyGetList, { ...input, cursor: 'c1' });
      expect(output(result)).toMatchObject({
        cursor: 'next',
        totalReturned: 0,
        truncated: true,
        shown: 0,
        notice: follow,
      });
      for (const surface of [String(output(result).notice), text(result)]) {
        expect(surface).not.toContain(last);
        expect(surface).not.toContain(none);
        expect(surface).not.toContain(FRAMEWORK_DEFAULT);
      }
    });

    it('says the previous page was the last when a followed cursor ends on an empty page', async () => {
      serve(0);
      const result = await runToolContract(bskyGetList, { ...input, cursor: 'c1' });
      expect(output(result)).toMatchObject({ totalReturned: 0, notice: last });
      expect(output(result)).not.toHaveProperty('truncated');
      expect(output(result)).not.toHaveProperty('cursor');
      expect(text(result)).toContain(last);
      expect(text(result)).not.toContain(none);
    });

    it('says nothing was found when the first page is empty without a cursor', async () => {
      serve(0);
      const result = await runToolContract(bskyGetList, input);
      expect(output(result)).toMatchObject({ totalReturned: 0, notice: none });
      expect(output(result)).not.toHaveProperty('truncated');
      expect(text(result)).toContain(none);
      expect(text(result)).not.toContain(last);
    });

    it('adds no page notice to a nonempty last page', async () => {
      serve(3);
      const result = await runToolContract(bskyGetList, { ...input, cursor: 'c1' });
      expect(output(result)).toMatchObject({ totalReturned: 3 });
      expect(output(result)).not.toHaveProperty('notice');
      expect(output(result)).not.toHaveProperty('truncated');
      expect(text(result)).not.toContain(last);
      expect(text(result)).not.toContain(none);
    });

    it('keeps the clamp notice alone on a nonempty last page', async () => {
      serve(3);
      const result = await runToolContract(bskyGetList, { ...input, limit: 150 });
      const clamp = 'limit 150 requested; 100 applied.';
      expect(output(result)).toMatchObject({ totalReturned: 3, notice: clamp });
      expect(output(result)).not.toHaveProperty('truncated');
      expect(text(result)).toContain(clamp);
      for (const wording of [follow, last, none]) expect(text(result)).not.toContain(wording);
    });

    it.each([
      ['the first page', {}, none],
      ['a page a cursor led to', { cursor: 'c1' }, last],
    ])(
      'ends on an empty returned cursor on %s instead of saying to follow it',
      async (_label, paging, notice) => {
        serve(0, '');
        const result = await runToolContract(bskyGetList, { ...input, ...paging });
        expect(output(result)).toMatchObject({ cursor: '', totalReturned: 0, notice });
        expect(output(result)).not.toHaveProperty('truncated');
        expect(text(result)).toContain(notice);
        expect(text(result)).not.toContain(follow);
      },
    );
  },
);

describe('bsky_get_list validation and formatting', () => {
  it('distinguishes an empty field from two authored quote characters', async () => {
    const authored = { ...list, name: '""' };
    route('app.bsky.graph.getList', () => Response.json({ list: authored, items: [] }));
    const result = await runToolContract(bskyGetList, { list: LIST });
    expect(output(result)).toEqual({
      list: authored,
      members: [],
      totalReturned: 0,
      notice: 'No members found on this list.',
    });
    expect(text(result)).toContain('**Name:**\n> ""');
    expect(text(result)).toContain('**Description (JSON string):**\n> ""');
  });

  it.each([
    [{ list: LIST, actor: 'nytimes.com' }, 'invalid_mode'],
    [{ list: LIST, kind: 'lists' }, 'invalid_mode'],
    [{ actor: 'nytimes.com' }, 'invalid_mode'],
    [{ kind: 'lists' }, 'invalid_mode'],
    [{}, 'invalid_mode'],
    [{ list: 'https://bsky.app/starter-pack-short/1a2b' }, 'invalid_arguments'],
    [{ list: 'https://bsky.app/starter-pack/nytimes.com/..?ref=1' }, 'invalid_arguments'],
    [{ list: `at://${DID}/app.bsky.graph.list/.` }, 'invalid_arguments'],
    [{ list: FIRST_FEED }, 'invalid_arguments'],
    [
      { actor: 'https://bsky.app/profile/nytimes.com/lists/news', kind: 'lists' },
      'invalid_arguments',
    ],
    [{ list: LIST, limit: 0 }, 'invalid_arguments'],
  ] as const)('rejects %j before sending a request', async (input, reason) => {
    const result = await runToolContract(bskyGetList, input);
    expect(result.isError).toBe(true);
    expect(output(result)).toHaveProperty('error.data.reason', reason);
    if (reason === 'invalid_mode') {
      const hint = 'Use list by itself, or provide actor together with kind.';
      expect(output(result)).toHaveProperty('error.data.recovery.hint', hint);
      expect(text(result)).toContain(hint);
    }
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    [
      { list: LIST },
      'app.bsky.graph.getList',
      'List not found',
      'list_not_found',
      'Check the list AT-URI or discover the owner’s lists with actor and kind lists.',
    ],
    [
      { list: PACK },
      'app.bsky.graph.getStarterPack',
      'Starter pack not found',
      'starter_pack_not_found',
      'Check the starter pack AT-URI or discover the owner’s packs with actor and kind starterPacks.',
    ],
    [
      { list: 'at://missing.example/app.bsky.graph.list/news' },
      'com.atproto.identity.resolveHandle',
      'Unable to resolve handle',
      'list_not_found',
      'Check the list AT-URI or discover the owner’s lists with actor and kind lists.',
    ],
    [
      { actor: 'missing.example', kind: 'starterPacks' },
      'app.bsky.graph.getActorStarterPacks',
      'Profile not found',
      'actor_not_found',
      'Verify the handle or DID with bsky_get_profile or find the account with bsky_search_actors.',
    ],
  ] as const)(
    'maps %j to the declared not-found reason and recovery',
    async (input, lexicon, message, reason, hint) => {
      route(lexicon, () => xrpcError(message));
      const result = await runToolContract(bskyGetList, input);
      expect(result.isError).toBe(true);
      expect(output(result)).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason, recovery: { hint } } },
      });
      expect(text(result)).toContain(hint);
      expect(http.calls).toHaveLength(1);
    },
  );

  it('fails an unknown DID as actor_not_found, though discovery answers it with an empty page', async () => {
    const unknown = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    route('app.bsky.graph.getLists', () => Response.json({ lists: [] }));
    route('app.bsky.actor.getProfile', () => xrpcError('Profile not found'));
    const result = await runToolContract(bskyGetList, { actor: unknown, kind: 'lists' });
    const hint =
      'Verify the handle or DID with bsky_get_profile or find the account with bsky_search_actors.';
    expect(result.isError).toBe(true);
    expect(output(result)).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'actor_not_found', recovery: { hint } },
      },
    });
    expect(text(result)).toContain(hint);
    expect(text(result)).not.toContain('No lists found');
    expect(requests().map((url) => [url.pathname, Object.fromEntries(url.searchParams)])).toEqual([
      ['/xrpc/app.bsky.graph.getLists', { actor: unknown, limit: '25' }],
      ['/xrpc/app.bsky.actor.getProfile', { actor: unknown }],
    ]);
  });

  it('fails an actor the AppView rejects as an invalid identifier as actor_not_found, after one request', async () => {
    /** 255 characters: it passes the input pattern, and the AppView rejects it as malformed. */
    const long = `${`${'a'.repeat(60)}.`.repeat(4)}example.com`;
    route('app.bsky.graph.getLists', () =>
      xrpcError(`Invalid app.bsky.graph.getLists params: Invalid AT identifier (got "${long}")`),
    );
    recordStrays();
    const result = await runToolContract(bskyGetList, { actor: long, kind: 'lists' });
    const hint =
      'Verify the handle or DID with bsky_get_profile or find the account with bsky_search_actors.';
    expect(result.isError).toBe(true);
    expect(output(result)).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'actor_not_found', recovery: { hint } },
      },
    });
    expect(text(result)).toContain(hint);
    expect(requests().map((url) => [url.pathname, Object.fromEntries(url.searchParams)])).toEqual([
      ['/xrpc/app.bsky.graph.getLists', { actor: long, limit: '25' }],
    ]);
  });

  it('says so when a DID’s empty discovery page could not be checked against its profile', async () => {
    const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    route('app.bsky.graph.getActorStarterPacks', () => Response.json({ starterPacks: [] }));
    route('app.bsky.actor.getProfile', () =>
      Response.json({ error: 'Unavailable' }, { status: 503, headers: { 'Retry-After': '31' } }),
    );
    const result = await runToolContract(bskyGetList, { actor: did, kind: 'starterPacks' });
    const notice = `No starter packs found for actor "${did}". Bluesky did not confirm that the account exists.`;
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({ starterPacks: [], totalReturned: 0, notice });
    expect(text(result)).toContain(notice);
  });

  it('round-trips literal names, descriptions, and display names without adding markup or links', async () => {
    const value = ' \t> [Click](https://bad.example/)\r\n<script>&copy;</script>\n\n`\u0000 ';
    const authored = {
      ...list,
      name: value,
      description: value,
      creator: { ...owner, displayName: value },
    };
    route('app.bsky.graph.getList', () => Response.json({ list: authored, items: [], cursor: '' }));
    const result = await runToolContract(bskyGetList, { list: LIST });
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({
      list: authored,
      members: [],
      cursor: '',
      totalReturned: 0,
      notice: 'No members found on this list.',
    });
    const ast = new Parser().parse(text(result)).walker();
    const links: string[] = [];
    const quoted: string[] = [];
    let quoteDepth = 0;
    for (let event = ast.next(); event; event = ast.next()) {
      if (event.node.type === 'block_quote') {
        quoteDepth += event.entering ? 1 : -1;
        if (event.entering) quoted.push('');
      }
      if (!event.entering) continue;
      if (event.node.type === 'link') links.push(event.node.destination ?? '');
      if (event.node.type === 'text' && quoteDepth === 1) {
        const index = quoted.length - 1;
        quoted[index] = (quoted[index] ?? '') + (event.node.literal ?? '');
      }
      expect(['html_inline', 'html_block', 'image', 'code', 'code_block']).not.toContain(
        event.node.type,
      );
    }
    expect(links).toEqual([LIST]);
    // The last block quote is the enrichment notice the framework appends, not authored text.
    expect(quoted.at(-1)).toBe('No members found on this list.');
    expect(quoted.slice(0, -1).map((entry) => JSON.parse(entry))).toEqual([value, value, value]);
    expect(text(result)).toContain('**Name (JSON string):**');
    expect(text(result)).toContain('No members on this page.');
    expect(text(result)).toContain('**Cursor:** ""');
  });
});

/**
 * Records Bluesky serves that this server cannot read. `BAD_PACK` is a real starter pack whose
 * record names its backing list with a misspelled collection, served with no hydrated list view.
 */
describe('bsky_get_list records Bluesky sent malformed', () => {
  const OWNER = { did: 'did:plc:xgs3qrwos3dwxmixoflcxrhu', handle: 'devin.divy.zone' };
  const BAD_PACK = `at://${OWNER.did}/app.bsky.graph.starterpack/3kvrbgdrtbs2v`;
  const UNREADABLE_LIST = 'at://did:web:example/app.bsly.graph.list/example';
  const badPack = (rkey = '3kvrbgdrtbs2v') => ({
    uri: `at://${OWNER.did}/app.bsky.graph.starterpack/${rkey}`,
    creator: OWNER,
    record: { name: 'Test pack', list: UNREADABLE_LIST },
  });
  const projected = { uri: PACK, name: 'NYT starter pack', creator: owner, listUri: LIST };
  const follow =
    'Pass the returned cursor with the same actor and kind to fetch the next page of starter packs, even after an empty page.';

  it('leaves a malformed starter pack out of discovery and counts it on both surfaces', async () => {
    route('app.bsky.graph.getActorStarterPacks', () =>
      Response.json({ starterPacks: [pack, badPack()] }),
    );
    recordStrays();
    const result = await runToolContract(bskyGetList, {
      actor: 'devin.divy.zone',
      kind: 'starterPacks',
    });
    const notice = '1 starter pack Bluesky sent on this page could not be read and is left out.';
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({ starterPacks: [projected], totalReturned: 1, notice });
    expect(text(result)).toContain(notice);
    expect(text(result)).toContain(PACK);
    expect(text(result)).not.toContain(BAD_PACK);
    expect(requests().map((url) => url.pathname)).toEqual([
      '/xrpc/app.bsky.graph.getActorStarterPacks',
    ]);
  });

  it.each([
    [
      'a first page for a DID',
      { actor: OWNER.did, kind: 'starterPacks' },
      'app.bsky.graph.getActorStarterPacks',
      { starterPacks: [badPack(), badPack('other')] },
      '2 starter packs Bluesky sent on this page could not be read and are left out.',
      'No starter packs found',
    ],
    [
      'a page a cursor led to',
      { actor: 'devin.divy.zone', kind: 'lists', cursor: 'c1' },
      'app.bsky.graph.getLists',
      { lists: [{ ...list, uri: UNREADABLE_LIST }] },
      '1 list Bluesky sent on this page could not be read and is left out.',
      'the previous page was the last',
    ],
  ] as const)(
    'says the rows could not be read when every row on %s was left out',
    async (_label, input, lexicon, body, notice, absent) => {
      route(lexicon, () => Response.json(body));
      recordStrays();
      const result = await runToolContract(bskyGetList, input);
      const key = input.kind;
      expect(result.isError).toBeFalsy();
      expect(output(result)).toEqual({ [key]: [], totalReturned: 0, notice });
      expect(text(result)).toContain(notice);
      expect(text(result)).not.toContain(absent);
      expect(String(output(result).notice)).not.toContain(absent);
      expect(requests().map((url) => url.pathname)).toEqual([`/xrpc/${lexicon}`]);
    },
  );

  it('keeps the clamp notice first and the cursor instruction last on a page with a row left out', async () => {
    route('app.bsky.graph.getActorStarterPacks', () =>
      Response.json({ starterPacks: [badPack(), pack], cursor: 'next' }),
    );
    recordStrays();
    const result = await runToolContract(bskyGetList, {
      actor: 'devin.divy.zone',
      kind: 'starterPacks',
      limit: 150,
    });
    const clamp = 'limit 150 requested; 100 applied.';
    const omitted = '1 starter pack Bluesky sent on this page could not be read and is left out.';
    expect(output(result)).toEqual({
      starterPacks: [projected],
      cursor: 'next',
      totalReturned: 1,
      truncated: true,
      shown: 1,
      cap: 100,
      notice: `${clamp} ${omitted} ${follow}`,
    });
    const rendered = text(result);
    expect(rendered.indexOf(clamp)).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf(clamp)).toBeLessThan(rendered.indexOf(omitted));
    expect(rendered.indexOf(omitted)).toBeLessThan(rendered.indexOf(follow));
    expect(rendered).not.toContain(FRAMEWORK_DEFAULT);
  });

  it('returns a starter pack whose backing list reference is not a list AT-URI, with membership unavailable', async () => {
    route('app.bsky.graph.getStarterPack', () => Response.json({ starterPack: badPack() }));
    recordStrays();
    const result = await runToolContract(bskyGetList, { list: BAD_PACK });
    const notice =
      'Starter pack membership is unavailable because its backing list reference could not be read.';
    expect(result.isError).toBeFalsy();
    expect(output(result)).toEqual({
      starterPack: { uri: BAD_PACK, name: 'Test pack', creator: OWNER, listUri: UNREADABLE_LIST },
      notice,
    });
    const rendered = text(result);
    expect(rendered).toContain(notice);
    expect(rendered).not.toContain('could not find');
    expect(rendered).not.toContain('No members on this page.');
    expect(rendered).toContain(`"${UNREADABLE_LIST}"`);
    const links: string[] = [];
    const walker = new Parser().parse(rendered).walker();
    for (let event = walker.next(); event; event = walker.next()) {
      if (event.entering && event.node.type === 'link') links.push(event.node.destination ?? '');
    }
    expect(links).toEqual([BAD_PACK]);
    expect(requests().map((url) => url.pathname)).toEqual(['/xrpc/app.bsky.graph.getStarterPack']);
  });
});

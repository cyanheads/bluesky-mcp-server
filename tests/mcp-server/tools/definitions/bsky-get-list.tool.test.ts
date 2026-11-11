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
    expect(output(next)).toEqual({ list, members: [member('second')] });
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
      notice: 'limit 150 requested; 100 applied.',
    });
    expect(text(next)).toContain('No starter packs on this page.');
    expect(text(next)).toContain('limit 150 requested; 100 applied.');
    expect(requests().map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { actor: 'nytimes.com', limit: '100' },
      { actor: 'nytimes.com', limit: '100', cursor: 'p2' },
    ]);
  });
});

describe('bsky_get_list validation and formatting', () => {
  it('distinguishes an empty field from two authored quote characters', async () => {
    const authored = { ...list, name: '""' };
    route('app.bsky.graph.getList', () => Response.json({ list: authored, items: [] }));
    const result = await runToolContract(bskyGetList, { list: LIST });
    expect(output(result)).toEqual({ list: authored, members: [] });
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
    expect(output(result)).toEqual({ list: authored, members: [], cursor: '' });
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
    expect(quoted.map((entry) => JSON.parse(entry))).toEqual([value, value, value]);
    expect(text(result)).toContain('**Name (JSON string):**');
    expect(text(result)).toContain('No members on this page.');
    expect(text(result)).toContain('**Cursor:** ""');
  });
});

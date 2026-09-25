/**
 * @fileoverview bsky_get_follows paging through the real service over a faked global `fetch`. The
 * fake serves the follow graph the way the AppView does: it pages over follow records and drops the
 * ones whose account no longer resolves, so a page can come back shorter than `limit` with a cursor,
 * and the cursor can lead to an empty page. Every assertion reads the assembled tool result, both
 * surfaces. Any request no test routed rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-get-follows.paging.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

const ACTOR = 'alice.bsky.social';
const SUBJECT = { did: 'did:plc:subject', handle: ACTOR, displayName: 'Alice' };

const profileView = (i: number) => ({
  did: `did:plc:acct${i}`,
  handle: `acct${i}.bsky.social`,
  displayName: `Account ${i}`,
});

/**
 * Graph pages keyed by the cursor that requests them (`''` is the first page). Each entry is the
 * accounts that page resolves to and the cursor it hands back.
 */
type GraphPages = Record<string, { accounts: number[]; cursor?: string }>;

function routeGraph(endpoint: 'getFollowers' | 'getFollows', pages: GraphPages) {
  const listKey = endpoint === 'getFollowers' ? 'followers' : 'follows';
  http.route({
    method: 'GET',
    match: new RegExp(`app\\.bsky\\.graph\\.${endpoint}\\?`),
    respond: (request) => {
      const page = pages[new URL(request.url).searchParams.get('cursor') ?? ''];
      if (!page)
        return Response.json({ error: 'InvalidRequest', message: 'bad cursor' }, { status: 400 });
      return Response.json({
        [listKey]: page.accounts.map(profileView),
        subject: SUBJECT,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
    },
  });
}

type Structured = {
  actors: Array<Record<string, unknown>>;
  subject: Record<string, unknown>;
  cursor?: string;
  totalReturned: number;
  truncated?: boolean;
  shown?: number;
  cap?: number;
  notice?: string;
};
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Structured;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');
const sentParams = (i: number) => new URL(http.calls[i]?.request.url ?? '').searchParams;

const nextPage = (direction: string) =>
  `Pass the returned cursor to fetch the next page of ${direction}. It can come back empty when the remaining accounts are unavailable.`;

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});

afterEach(() => {
  http.restore();
});

describe('bsky_get_follows — walking a follower graph to its end', () => {
  /** Page 1 fills the limit, page 2 is short but still carries a cursor, page 3 is empty. */
  const pages: GraphPages = {
    '': { accounts: [1, 2, 3], cursor: 'c2' },
    c2: { accounts: [4], cursor: 'c3' },
    c3: { accounts: [] },
  };

  it('page 1: a full page with a cursor is truncated, with the cursor notice on both surfaces', async () => {
    routeGraph('getFollowers', pages);
    const result = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'followers',
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(sentParams(0).get('limit')).toBe('3');
    expect(sentParams(0).has('cursor')).toBe(false);
    const out = structured(result);
    expect(out.actors.map((a) => a.handle)).toEqual([
      'acct1.bsky.social',
      'acct2.bsky.social',
      'acct3.bsky.social',
    ]);
    expect(out).toMatchObject({ cursor: 'c2', truncated: true, shown: 3, cap: 3 });
    expect(out.notice).toBe(nextPage('followers'));
    const text = textOf(result);
    expect(text).toContain(nextPage('followers'));
    expect(text).toContain('c2');
  });

  it('page 2: a short page that still carries a cursor is truncated', async () => {
    routeGraph('getFollowers', pages);
    const result = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'followers',
      limit: 3,
      cursor: 'c2',
    });

    expect(sentParams(0).get('cursor')).toBe('c2');
    const out = structured(result);
    expect(out.actors.map((a) => a.handle)).toEqual(['acct4.bsky.social']);
    expect(out).toMatchObject({ cursor: 'c3', truncated: true, shown: 1, cap: 3 });
    expect(out.notice).toBe(nextPage('followers'));
  });

  it('page 3: an empty continuation page says the previous page was the last, not "none found"', async () => {
    routeGraph('getFollowers', pages);
    const result = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'followers',
      limit: 3,
      cursor: 'c3',
    });

    const out = structured(result);
    expect(out.actors).toEqual([]);
    expect(out).not.toHaveProperty('cursor');
    expect(out).not.toHaveProperty('truncated');
    expect(out.totalReturned).toBe(0);
    expect(out.notice).toBe('No more followers — the previous page was the last.');
    const text = textOf(result);
    expect(text).toContain('No more followers — the previous page was the last.');
    expect(text).not.toContain('No followers found');
    // The rendered body must not contradict the notice below it with a "none found" of its own.
    expect(text).not.toMatch(/no accounts found/i);
    expect(text).toContain('*No accounts on this page.*');
  });

  it('names the accounts an actor follows as "followed accounts" in every notice', async () => {
    routeGraph('getFollows', {
      '': { accounts: [1], cursor: 'f2' },
      f2: { accounts: [] },
    });

    const firstResult = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'following',
      limit: 5,
    });
    const first = structured(firstResult);
    expect(first).toMatchObject({ truncated: true, shown: 1, cap: 5 });
    expect(first.notice).toBe(nextPage('followed accounts'));
    expect(textOf(firstResult)).toContain(nextPage('followed accounts'));

    const lastResult = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'following',
      limit: 5,
      cursor: 'f2',
    });
    const last = structured(lastResult);
    expect(last).not.toHaveProperty('truncated');
    expect(last.notice).toBe('No more followed accounts — the previous page was the last.');
    expect(textOf(lastResult)).not.toMatch(/page of following|No more following/);
    expect(http.calls.every((c) => c.request.url.includes('app.bsky.graph.getFollows?'))).toBe(
      true,
    );
  });

  it('names followed accounts in the no-match notice of an empty first page', async () => {
    routeGraph('getFollows', { '': { accounts: [] } });
    const out = structured(
      await runToolContract(bskyGetFollows, { actor: ACTOR, direction: 'following' }),
    );
    expect(out.notice).toBe(`No followed accounts found for actor "${ACTOR}".`);
  });

  it('a last page with accounts and no cursor carries neither truncation nor a notice', async () => {
    routeGraph('getFollowers', { '': { accounts: [1, 2] } });
    const result = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'followers',
      limit: 25,
    });

    const out = structured(result);
    expect(out.actors).toHaveLength(2);
    expect(out).not.toHaveProperty('cursor');
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('cursor:');
  });

  it('a first page with no accounts keeps the no-match notice naming the actor', async () => {
    routeGraph('getFollowers', { '': { accounts: [] } });
    const result = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'followers',
    });

    const out = structured(result);
    expect(out).not.toHaveProperty('truncated');
    expect(out.notice).toBe(`No followers found for actor "${ACTOR}".`);
    expect(textOf(result)).toContain('*No accounts on this page.*');
  });

  it('an empty page that still hands back a cursor is truncated, never "the last"', async () => {
    routeGraph('getFollowers', { '': { accounts: [], cursor: 'c2' } });
    const result = await runToolContract(bskyGetFollows, {
      actor: ACTOR,
      direction: 'followers',
    });

    const out = structured(result);
    expect(out).toMatchObject({ cursor: 'c2', truncated: true, shown: 0, cap: 25 });
    expect(out.notice).toBe(nextPage('followers'));
  });
});

describe('bsky_get_follows — profileView carries no counts', () => {
  it('never puts a follower or following count on either surface, from one upstream request', async () => {
    http.route({
      method: 'GET',
      match: /app\.bsky\.graph\.getFollowers\?/,
      respond: Response.json({
        followers: [{ ...profileView(1), followersCount: 7, followsCount: 3 }],
        subject: { ...SUBJECT, followersCount: 11, followsCount: 2 },
      }),
    });

    const result = await runToolContract(bskyGetFollows, { actor: ACTOR, direction: 'followers' });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    const out = structured(result);
    expect(out.actors[0]).not.toHaveProperty('followersCount');
    expect(out.subject).not.toHaveProperty('followersCount');
    expect(out.subject).not.toHaveProperty('followsCount');
    const text = textOf(result);
    expect(text).not.toMatch(/Followers:|Following:/);
  });
});

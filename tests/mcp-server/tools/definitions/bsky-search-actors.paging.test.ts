/**
 * @fileoverview bsky_search_actors paging through the real service over a faked global `fetch`.
 * The fake pages the way `searchActors` does live: pages often hold fewer actors than `limit` and
 * still carry a cursor, and the last page carries none. Every assertion reads the assembled tool
 * result, both surfaces. Any request no test routed rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-search-actors.paging.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

const NEXT_PAGE = 'Pass the returned cursor to fetch the next page of actors.';

const profileView = (i: number) => ({
  did: `did:plc:acct${i}`,
  handle: `acct${i}.bsky.social`,
  displayName: `Account ${i}`,
});

type SearchPages = Record<string, { actors: number[]; cursor?: string }>;

function routeSearch(pages: SearchPages) {
  http.route({
    method: 'GET',
    match: /app\.bsky\.actor\.searchActors\?/,
    respond: (request) => {
      const page = pages[new URL(request.url).searchParams.get('cursor') ?? ''];
      if (!page)
        return Response.json({ error: 'InvalidRequest', message: 'bad cursor' }, { status: 400 });
      return Response.json({
        actors: page.actors.map(profileView),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
    },
  });
}

type Structured = {
  actors: Array<Record<string, unknown>>;
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

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});

afterEach(() => {
  http.restore();
});

describe('bsky_search_actors — walking a result set to its end', () => {
  /** Page 1 fills the limit, page 2 is short but continues, page 3 is the short last page. */
  const pages: SearchPages = {
    '': { actors: [1, 2, 3, 4], cursor: 'p2' },
    p2: { actors: [5, 6], cursor: 'p3' },
    p3: { actors: [7] },
  };

  it('page 1: a full page with a cursor is truncated, with the paging notice on both surfaces', async () => {
    routeSearch(pages);
    const result = await runToolContract(bskySearchActors, { query: 'orcid', limit: 4 });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(sentParams(0).get('q')).toBe('orcid');
    expect(sentParams(0).get('limit')).toBe('4');
    const out = structured(result);
    expect(out.actors).toHaveLength(4);
    expect(out).toMatchObject({ cursor: 'p2', truncated: true, shown: 4, cap: 4 });
    expect(out.notice).toBe(NEXT_PAGE);
    const text = textOf(result);
    expect(text).toContain(NEXT_PAGE);
    expect(text).toContain('p2');
  });

  it('page 2: a short page that still carries a cursor is truncated', async () => {
    routeSearch(pages);
    const result = await runToolContract(bskySearchActors, {
      query: 'orcid',
      limit: 4,
      cursor: 'p2',
    });

    expect(sentParams(0).get('cursor')).toBe('p2');
    const out = structured(result);
    expect(out.actors.map((a) => a.handle)).toEqual(['acct5.bsky.social', 'acct6.bsky.social']);
    expect(out).toMatchObject({ cursor: 'p3', truncated: true, shown: 2, cap: 4 });
    expect(out.notice).toBe(NEXT_PAGE);
  });

  it('page 3: the short last page with no cursor carries neither truncation nor a notice', async () => {
    routeSearch(pages);
    const result = await runToolContract(bskySearchActors, {
      query: 'orcid',
      limit: 4,
      cursor: 'p3',
    });

    const out = structured(result);
    expect(out.actors.map((a) => a.handle)).toEqual(['acct7.bsky.social']);
    expect(out).not.toHaveProperty('cursor');
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('cursor:');
  });

  it('an empty continuation page says the previous page was the last, not "no match"', async () => {
    routeSearch({ '': { actors: [1], cursor: 'p2' }, p2: { actors: [] } });
    const result = await runToolContract(bskySearchActors, {
      query: 'orcid',
      limit: 1,
      cursor: 'p2',
    });

    const out = structured(result);
    expect(out.actors).toEqual([]);
    expect(out).not.toHaveProperty('truncated');
    expect(out.notice).toBe('No more actors match "orcid" — the previous page was the last.');
    const text = textOf(result);
    expect(text).toContain('No more actors match "orcid" — the previous page was the last.');
    expect(text).not.toContain('No actors matched');
    // The rendered body must not contradict the notice below it with a "none found" of its own.
    expect(text).not.toMatch(/no matching actors found/i);
    expect(text).toContain('No actors on this page.');
  });

  it('a first page with no actors keeps the no-match notice naming the query', async () => {
    routeSearch({ '': { actors: [] } });
    const result = await runToolContract(bskySearchActors, { query: 'zzqqxx' });

    const out = structured(result);
    expect(out).not.toHaveProperty('truncated');
    expect(out.notice).toBe('No actors matched "zzqqxx". Try a different name or handle fragment.');
    expect(textOf(result)).toContain('No actors on this page.');
  });
});

describe('bsky_search_actors — profileView carries no counts', () => {
  it('never puts a follower count on either surface, from one upstream request', async () => {
    http.route({
      method: 'GET',
      match: /app\.bsky\.actor\.searchActors\?/,
      respond: Response.json({ actors: [{ ...profileView(1), followersCount: 100 }] }),
    });

    const result = await runToolContract(bskySearchActors, { query: 'acct' });

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(structured(result).actors[0]).not.toHaveProperty('followersCount');
    expect(textOf(result)).not.toContain('Followers:');
  });
});

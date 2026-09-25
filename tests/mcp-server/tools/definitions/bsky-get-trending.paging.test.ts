/**
 * @fileoverview bsky_get_trending's truncation rule through the real service over a faked global
 * `fetch`. The fake behaves like the live `getTrends`: it serves the first `limit` topics of a fixed
 * pool and answers HTTP 400 above 25, the endpoint's maximum — so the limit the handler sends
 * upstream, the slice back to the caller's limit, and the notice on the assembled result are all the
 * production code paths. Any request no test routed rejects with `unmocked fetch`.
 * @module tests/mcp-server/tools/definitions/bsky-get-trending.paging.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetTrending } from '@/mcp-server/tools/definitions/bsky-get-trending.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const MAX = 25;
const NOTICE = 'More topics are trending — raise limit (max 25) to see them.';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

const rawTrend = (i: number) => ({
  topic: `trend${String(i).padStart(2, '0')}`,
  displayName: `Topic ${i}`,
  link: `/profile/did:plc:trending/feed/trend${String(i).padStart(2, '0')}`,
  postCount: 1000 - i,
});

/** Route getTrends to a pool of `size` topics, served the way the AppView serves them. */
function trendingPool(size: number) {
  http.route({
    method: 'GET',
    match: /app\.bsky\.unspecced\.getTrends/,
    respond: (request) => {
      const limit = Number(new URL(request.url).searchParams.get('limit'));
      if (limit > MAX) {
        return Response.json(
          {
            error: 'InvalidRequest',
            message: `Invalid app.bsky.unspecced.getTrends params: integer too big (maximum 25, got ${limit})`,
          },
          { status: 400 },
        );
      }
      return Response.json({
        trends: Array.from({ length: Math.min(limit, size) }, (_, i) => rawTrend(i + 1)),
      });
    },
  });
}

const sentLimits = () =>
  http.calls.map((c) => Number(new URL(c.request.url).searchParams.get('limit')));
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as {
    trends: Array<{ topic: string }>;
    totalReturned: number;
    truncated?: boolean;
    shown?: number;
    cap?: number;
    notice?: string;
  };
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

describe('bsky_get_trending — truncation keyed on one topic past the limit', () => {
  it('asks upstream for one topic past the limit, in a single request', async () => {
    trendingPool(MAX);
    await runToolContract(bskyGetTrending, { limit: 10 });
    expect(sentLimits()).toEqual([11]);
  });

  it('at limit 25 asks for 25, never 26, and reports no truncation', async () => {
    trendingPool(MAX);
    const result = await runToolContract(bskyGetTrending, { limit: 25 });

    expect(result.isError).toBeFalsy();
    expect(sentLimits()).toEqual([25]);
    const out = structured(result);
    expect(out.trends).toHaveLength(25);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
    expect(textOf(result)).not.toContain('raise limit');
  });

  it('reports no truncation when the pool holds exactly the limit', async () => {
    trendingPool(23);
    const result = await runToolContract(bskyGetTrending, { limit: 23 });

    expect(sentLimits()).toEqual([24]);
    const out = structured(result);
    expect(out.trends).toHaveLength(23);
    expect(out.totalReturned).toBe(23);
    expect(out).not.toHaveProperty('truncated');
    expect(out).not.toHaveProperty('notice');
  });

  it('reports no truncation when the pool is smaller than the limit', async () => {
    trendingPool(4);
    const out = structured(await runToolContract(bskyGetTrending, { limit: 10 }));
    expect(out.trends).toHaveLength(4);
    expect(out).not.toHaveProperty('truncated');
  });

  it('at limit 24 of a 25-topic pool returns 24 on both surfaces and discloses the 25th', async () => {
    trendingPool(MAX);
    const result = await runToolContract(bskyGetTrending, { limit: 24 });

    expect(sentLimits()).toEqual([25]);
    const out = structured(result);
    expect(out.trends).toHaveLength(24);
    expect(out.trends.map((t) => t.topic)).not.toContain('trend25');
    expect(out).toMatchObject({ truncated: true, shown: 24, cap: 24, totalReturned: 24 });
    expect(out.notice).toBe(NOTICE);

    const text = textOf(result);
    expect(text).toContain('24. **Topic 24**');
    expect(text).not.toContain('25. **');
    expect(text).not.toContain('Topic 25');
    expect(text).toContain(NOTICE);
  });

  it('at limit 1 returns only the first topic and discloses the rest', async () => {
    trendingPool(MAX);
    const result = await runToolContract(bskyGetTrending, { limit: 1 });

    expect(sentLimits()).toEqual([2]);
    const out = structured(result);
    expect(out.trends.map((t) => t.topic)).toEqual(['trend01']);
    expect(out).toMatchObject({ truncated: true, shown: 1, cap: 1 });
    expect(textOf(result)).not.toContain('Topic 2');
  });

  it('with no topics trending reports neither truncation nor a cap notice', async () => {
    trendingPool(0);
    const result = await runToolContract(bskyGetTrending, { limit: 10 });
    const out = structured(result);
    expect(out.trends).toEqual([]);
    expect(out).not.toHaveProperty('truncated');
    expect(textOf(result)).toContain('No trending topics');
  });

  it('describes limit 25 as the ceiling and the truncated rule', () => {
    const limitDescribe = bskyGetTrending.input.shape.limit.description ?? '';
    expect(limitDescribe).toContain('25');
    expect(limitDescribe).toMatch(/Bluesky's maximum/);
    const truncatedDescribe = bskyGetTrending.enrichment?.truncated?.description ?? '';
    expect(truncatedDescribe).toMatch(/more topics were trending than limit/i);
    expect(truncatedDescribe).not.toMatch(/capped at the requested limit/);
  });
});

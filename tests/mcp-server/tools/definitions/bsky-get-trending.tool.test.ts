/**
 * @fileoverview Tests for bsky_get_trending tool — unspecced endpoint.
 * @module tests/mcp-server/tools/definitions/bsky-get-trending.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyGetTrending } from '@/mcp-server/tools/definitions/bsky-get-trending.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { TrendingTopic, TrendsResult } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeTrend = (overrides: Partial<TrendingTopic> = {}): TrendingTopic => ({
  topic: 'ailaunch2025',
  displayName: 'AI Launch 2025',
  postCount: 5000,
  category: 'technology',
  status: 'hot',
  startedAt: '2025-01-01T10:00:00Z',
  link: 'https://bsky.app/search?q=ailaunch2025',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockGetTrends = vi.fn<[], Promise<TrendsResult>>();

vi.mock('@/services/bluesky/bluesky-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/services/bluesky/bluesky-service.js')>();
  return {
    ...orig,
    getBlueskyService: () => ({ getTrends: mockGetTrends }),
  };
});

// ---------------------------------------------------------------------------

describe('bskyGetTrending', () => {
  beforeEach(() => {
    initBlueskyService();
    mockGetTrends.mockReset();
  });

  // --- Happy path ---

  it('returns trending topics', async () => {
    mockGetTrends.mockResolvedValue({ trends: [makeTrend()] });

    const ctx = createMockContext();
    const input = bskyGetTrending.input.parse({ limit: 5 });
    const result = await bskyGetTrending.handler(input, ctx);

    expect(result.trends).toHaveLength(1);
    expect(result.trends[0].topic).toBe('ailaunch2025');
    expect(result.trends[0].displayName).toBe('AI Launch 2025');
    expect(result.trends[0].postCount).toBe(5000);
  });

  it('applies default limit=10', () => {
    const input = bskyGetTrending.input.parse({});
    expect(input.limit).toBe(10);
  });

  // --- Cap disclosure (no cursor on this endpoint) ---

  it('discloses truncation when the list fills the requested limit', async () => {
    mockGetTrends.mockResolvedValue({ trends: [makeTrend(), makeTrend({ topic: 't2' })] });

    const ctx = createMockContext();
    const input = bskyGetTrending.input.parse({ limit: 2 });
    await bskyGetTrending.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(2);
  });

  it('does not disclose truncation when fewer topics than the limit return', async () => {
    mockGetTrends.mockResolvedValue({ trends: [makeTrend()] });

    const ctx = createMockContext();
    const input = bskyGetTrending.input.parse({ limit: 10 });
    await bskyGetTrending.handler(input, ctx);

    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  // --- Empty trends ---

  it('returns empty trends array', async () => {
    mockGetTrends.mockResolvedValue({ trends: [] });

    const ctx = createMockContext();
    const input = bskyGetTrending.input.parse({});
    const result = await bskyGetTrending.handler(input, ctx);

    expect(result.trends).toHaveLength(0);
  });

  // --- Sparse trend (unspecced endpoint may omit many fields) ---

  it('handles trend with only required fields (topic, displayName)', async () => {
    const sparse: TrendingTopic = { topic: 'minimal', displayName: 'Minimal' };
    mockGetTrends.mockResolvedValue({ trends: [sparse] });

    const ctx = createMockContext();
    const input = bskyGetTrending.input.parse({});
    const result = await bskyGetTrending.handler(input, ctx);

    expect(result.trends[0].postCount).toBeUndefined();
    expect(result.trends[0].category).toBeUndefined();
    expect(() => bskyGetTrending.output.parse(result)).not.toThrow();
  });

  // --- format() ---

  it('renders displayName and postCount', () => {
    const output = { trends: [makeTrend()] };
    const blocks = bskyGetTrending.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('AI Launch 2025');
    expect(text).toMatch(/5[,.]?000/);
  });

  it('renders category and status', () => {
    const blocks = bskyGetTrending.format!({ trends: [makeTrend()] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('technology');
    expect(text).toContain('hot');
  });

  it('renders empty message when no trends', () => {
    const blocks = bskyGetTrending.format!({ trends: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No trending');
  });

  it('renders topic identifier when different from displayName', () => {
    const trend = makeTrend({ topic: 'internal_slug_xyz', displayName: 'Human Title' });
    const blocks = bskyGetTrending.format!({ trends: [trend] });
    const text = (blocks[0] as { text: string }).text;
    // Topic slug should appear since it differs from displayName
    expect(text).toContain('internal_slug_xyz');
  });

  it('does not render topic identifier when same as displayName', () => {
    const trend: TrendingTopic = { topic: 'Same Title', displayName: 'Same Title' };
    const blocks = bskyGetTrending.format!({ trends: [trend] });
    const text = (blocks[0] as { text: string }).text;
    // No duplication — topic line omitted when they match
    const matches = (text.match(/Same Title/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it('renders numbered list', () => {
    const trends = [makeTrend(), makeTrend({ topic: 't2', displayName: 'Topic 2' })];
    const blocks = bskyGetTrending.format!({ trends });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1.');
    expect(text).toContain('2.');
  });

  it('renders link when present', () => {
    const trend = makeTrend({ link: 'https://bsky.app/profile/trending.bsky.app/feed/123' });
    const blocks = bskyGetTrending.format!({ trends: [trend] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('https://bsky.app/profile/trending.bsky.app/feed/123');
  });
});

/**
 * @fileoverview Tests for bsky_get_trending tool — unspecced endpoint.
 * @module tests/mcp-server/tools/definitions/bsky-get-trending.tool.test
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyGetTrending } from '@/mcp-server/tools/definitions/bsky-get-trending.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { TrendingTopic, TrendsResult } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Shaped like the live getTrends: a hex feed record key for `topic`, a feed page for `link`. */
const makeTrend = (overrides: Partial<TrendingTopic> = {}): TrendingTopic => ({
  topic: '1d558a3bc9ff',
  displayName: 'AI Launch 2025',
  postCount: 5000,
  category: 'technology',
  status: 'cooling',
  startedAt: '2025-01-01T10:00:00Z',
  link: 'https://bsky.app/profile/did:plc:qrz3lhbyuxbeilrc6nekdqme/feed/1d558a3bc9ff',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockGetTrends = vi.fn<(params: { limit?: number }, ctx: Context) => Promise<TrendsResult>>();

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
    expect(result.trends[0]).toMatchObject({
      topic: '1d558a3bc9ff',
      displayName: 'AI Launch 2025',
      postCount: 5000,
    });
  });

  it('applies default limit=10', () => {
    const input = bskyGetTrending.input.parse({});
    expect(input.limit).toBe(10);
  });

  // --- Cap disclosure (no cursor on this endpoint) ---
  // The limit + 1 sentinel, and the slice back to limit, are covered through the real service in
  // bsky-get-trending.paging.test.ts.

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

    const [trend] = result.trends;
    expect(trend).toBeDefined();
    expect(trend?.postCount).toBeUndefined();
    expect(trend?.category).toBeUndefined();
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
    expect(text).toContain('cooling');
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

  // --- Representative actors ---

  it('carries actors through the handler and the output schema', async () => {
    const trend = makeTrend({
      actors: [
        { did: 'did:plc:one', handle: 'one.bsky.social', displayName: 'One' },
        { did: 'did:plc:two', handle: 'two.bsky.social' },
      ],
    });
    mockGetTrends.mockResolvedValue({ trends: [trend] });

    const ctx = createMockContext();
    const result = await bskyGetTrending.handler(bskyGetTrending.input.parse({}), ctx);

    expect(result.trends[0]?.actors).toHaveLength(2);
    expect(() => bskyGetTrending.output.parse(result)).not.toThrow();
  });

  it('keeps two-line topic and actor names on the lines that carry them', () => {
    const trend = makeTrend({
      displayName: 'Launch\n## @admin.bsky.social',
      actors: [{ did: 'did:plc:one', handle: 'one.bsky.social', displayName: 'One\n---' }],
    });
    const lines = (bskyGetTrending.format!({ trends: [trend] })[0] as { text: string }).text.split(
      '\n',
    );
    expect(lines).toContain('1. **Launch ## @admin.bsky.social**');
    expect(lines).toContain('     - One --- (@one.bsky.social) `did:plc:one`');
    expect(lines).not.toContain('---');
  });

  it('renders each actor handle, display name, and DID', () => {
    const trend = makeTrend({
      actors: [
        { did: 'did:plc:one', handle: 'one.bsky.social', displayName: 'One' },
        { did: 'did:plc:two', handle: 'two.bsky.social' },
      ],
    });
    const text = (bskyGetTrending.format!({ trends: [trend] })[0] as { text: string }).text;

    expect(text).toContain('One (@one.bsky.social)');
    expect(text).toContain('did:plc:one');
    expect(text).toContain('@two.bsky.social');
    expect(text).toContain('did:plc:two');
  });

  it('renders no Voices block when the trend carries no actors', () => {
    const text = (bskyGetTrending.format!({ trends: [makeTrend()] })[0] as { text: string }).text;
    expect(text).not.toContain('Voices');
  });

  // --- Feed drill-down (feedUri) and the story summary (description) ---

  it('renders the feed AT-URI for a trend that has one', () => {
    const feedUri = 'at://did:plc:qrz3lhbyuxbeilrc6nekdqme/app.bsky.feed.generator/1d558a3bc9ff';
    const blocks = bskyGetTrending.format!({ trends: [makeTrend({ feedUri })] });
    expect((blocks[0] as { text: string }).text).toContain(feedUri);
  });

  it('carries feedUri and description through the output schema', async () => {
    const trend = makeTrend({
      feedUri: 'at://did:plc:qrz3lhbyuxbeilrc6nekdqme/app.bsky.feed.generator/1d558a3bc9ff',
      description: 'A one-sentence summary.',
    });
    mockGetTrends.mockResolvedValue({ trends: [trend] });

    const result = await bskyGetTrending.handler(
      bskyGetTrending.input.parse({}),
      createMockContext(),
    );
    const parsed = bskyGetTrending.output.parse(result);

    expect(parsed.trends[0]?.feedUri).toBe(trend.feedUri);
    expect(parsed.trends[0]?.description).toBe('A one-sentence summary.');
  });

  it('renders the description as quoted third-party text, and nothing when absent', () => {
    const quoted = makeTrend({ description: 'Line one.\n## not a heading' });
    const lines = (bskyGetTrending.format!({ trends: [quoted] })[0] as { text: string }).text.split(
      '\n',
    );
    expect(lines.some((l) => /^\s*> Line one\.$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\s*> ## not a heading$/.test(l))).toBe(true);
    expect(lines).not.toContain('## not a heading');

    const bare = (bskyGetTrending.format!({ trends: [makeTrend()] })[0] as { text: string }).text;
    expect(bare).not.toContain('>');
  });

  it('routes drill-down to bsky_get_feed and never to post search', () => {
    const surface = JSON.stringify({
      description: bskyGetTrending.description,
      output: z.toJSONSchema(bskyGetTrending.output),
    });
    expect(surface).toContain('bsky_get_feed');
    expect(surface).not.toContain('bsky_search_posts');
    expect(surface).not.toMatch(/slug|"rising"|hot\/rising/);
  });

  it('renders link when present', () => {
    const trend = makeTrend({ link: 'https://bsky.app/profile/trending.bsky.app/feed/123' });
    const blocks = bskyGetTrending.format!({ trends: [trend] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('https://bsky.app/profile/trending.bsky.app/feed/123');
  });
});

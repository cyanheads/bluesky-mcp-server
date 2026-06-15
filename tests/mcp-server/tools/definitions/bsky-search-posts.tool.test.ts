/**
 * @fileoverview Tests for bsky_search_posts tool.
 * @module tests/mcp-server/tools/definitions/bsky-search-posts.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { PostView, SearchPostsResult } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const AUTHOR: PostView['author'] = {
  did: 'did:plc:abc123',
  handle: 'alice.bsky.social',
  displayName: 'Alice',
};

const makePost = (overrides: Partial<PostView> = {}): PostView => ({
  uri: 'at://did:plc:abc123/app.bsky.feed.post/rkey1',
  cid: 'bafyreiabc',
  text: 'Hello Bluesky',
  author: AUTHOR,
  likeCount: 5,
  repostCount: 2,
  replyCount: 1,
  createdAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock — intercept service calls
// ---------------------------------------------------------------------------

const mockSearchPosts = vi.fn<[], Promise<SearchPostsResult>>();

vi.mock('@/services/bluesky/bluesky-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/services/bluesky/bluesky-service.js')>();
  return {
    ...orig,
    getBlueskyService: () => ({ searchPosts: mockSearchPosts }),
  };
});

// ---------------------------------------------------------------------------

describe('bskySearchPosts', () => {
  beforeEach(() => {
    initBlueskyService();
    mockSearchPosts.mockReset();
  });

  // --- Happy path ---

  it('returns posts and enriches totalReturned', async () => {
    const post = makePost();
    mockSearchPosts.mockResolvedValue({ posts: [post] });

    const ctx = createMockContext();
    const input = bskySearchPosts.input.parse({ query: 'bluesky' });
    const result = await bskySearchPosts.handler(input, ctx);

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].uri).toBe(post.uri);
    expect(result.posts[0].text).toBe('Hello Bluesky');
    expect(result.cursor).toBeUndefined();
  });

  it('surfaces hitsTotal when API provides it and discloses it as totalCount', async () => {
    mockSearchPosts.mockResolvedValue({ posts: [makePost()], hitsTotal: 1234 });

    const ctx = createMockContext();
    const input = bskySearchPosts.input.parse({ query: 'test' });
    const result = await bskySearchPosts.handler(input, ctx);

    expect(result.hitsTotal).toBe(1234);
    expect(getEnrichment(ctx).totalCount).toBe(1234);
  });

  it('passes cursor through to next page', async () => {
    const nextCursor = 'opaque-cursor-abc';
    mockSearchPosts.mockResolvedValue({ posts: [makePost()], cursor: nextCursor });

    const ctx = createMockContext();
    const input = bskySearchPosts.input.parse({ query: 'test', cursor: 'prev-cursor' });
    const result = await bskySearchPosts.handler(input, ctx);

    expect(result.cursor).toBe(nextCursor);
  });

  it('discloses truncation when a cursor returns but no hitsTotal', async () => {
    mockSearchPosts.mockResolvedValue({ posts: [makePost()], cursor: 'more-abc' });

    const ctx = createMockContext();
    const input = bskySearchPosts.input.parse({ query: 'test', limit: 1 });
    await bskySearchPosts.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.cap).toBe(1);
  });

  it('applies defaults (sort=latest, limit=25)', () => {
    const input = bskySearchPosts.input.parse({ query: 'test' });
    expect(input.sort).toBe('latest');
    expect(input.limit).toBe(25);
  });

  // --- Empty results ---

  it('returns empty posts array when no results', async () => {
    mockSearchPosts.mockResolvedValue({ posts: [] });

    const ctx = createMockContext();
    const input = bskySearchPosts.input.parse({ query: 'xyznotfound999' });
    const result = await bskySearchPosts.handler(input, ctx);

    expect(result.posts).toHaveLength(0);
    expect(result.hitsTotal).toBeUndefined();
  });

  it('calls ctx.enrich.notice on empty results', async () => {
    mockSearchPosts.mockResolvedValue({ posts: [] });

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskySearchPosts.input.parse({ query: 'xyznotfound999' });
    await bskySearchPosts.handler(input, ctx);

    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0][0]).toContain('xyznotfound999');
  });

  it('does not call ctx.enrich.notice when results are returned', async () => {
    mockSearchPosts.mockResolvedValue({ posts: [makePost()] });

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskySearchPosts.input.parse({ query: 'bluesky' });
    await bskySearchPosts.handler(input, ctx);

    expect(noticeSpy).not.toHaveBeenCalled();
  });

  // --- Sparse upstream payload ---

  it('handles post missing all optional fields', async () => {
    const sparsePost: PostView = {
      uri: 'at://did:plc:abc/app.bsky.feed.post/r1',
      cid: 'bafyr1',
      text: 'sparse',
      author: { did: 'did:plc:abc', handle: 'sparse.bsky.social' },
    };
    mockSearchPosts.mockResolvedValue({ posts: [sparsePost] });

    const ctx = createMockContext();
    const input = bskySearchPosts.input.parse({ query: 'sparse' });
    const result = await bskySearchPosts.handler(input, ctx);

    expect(result.posts[0].likeCount).toBeUndefined();
    expect(result.posts[0].replyCount).toBeUndefined();
    expect(result.posts[0].embed).toBeUndefined();
    // Output must still validate against the output schema
    expect(() => bskySearchPosts.output.parse(result)).not.toThrow();
  });

  // --- format() ---

  it('renders hitsTotal in formatted output', () => {
    const output = {
      posts: [makePost()],
      hitsTotal: 999,
    };
    const blocks = bskySearchPosts.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('999');
    expect(text).toContain('Alice');
    expect(text).toContain('at://did:plc:abc123/app.bsky.feed.post/rkey1');
  });

  it('renders empty-result message when no posts', () => {
    const blocks = bskySearchPosts.format!({ posts: [] });
    expect((blocks[0] as { text: string }).text).toContain('No posts');
  });

  it('renders cursor in footer when present', () => {
    const blocks = bskySearchPosts.format!({ posts: [makePost()], cursor: 'next-page-token' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('next-page-token');
  });

  it('renders embed images inline', () => {
    const post = makePost({
      embed: { type: 'images', images: [{ url: 'https://cdn/img.jpg', alt: 'a cat' }] },
    });
    const blocks = bskySearchPosts.format!({ posts: [post] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('https://cdn/img.jpg');
    expect(text).toContain('a cat');
  });

  it('renders external embed link', () => {
    const post = makePost({
      embed: {
        type: 'external',
        uri: 'https://example.com',
        title: 'Example',
        description: 'An example site',
      },
    });
    const blocks = bskySearchPosts.format!({ posts: [post] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('https://example.com');
    expect(text).toContain('Example');
  });

  it('renders quoted post embed', () => {
    const post = makePost({
      embed: {
        type: 'record',
        uri: 'at://did:plc:x/app.bsky.feed.post/q1',
        cid: 'bafyrq1',
        text: 'quoted text',
      },
    });
    const blocks = bskySearchPosts.format!({ posts: [post] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('at://did:plc:x/app.bsky.feed.post/q1');
  });

  it('renders reply-to indicator', () => {
    const post = makePost({ replyToUri: 'at://did:plc:abc/app.bsky.feed.post/parent1' });
    const blocks = bskySearchPosts.format!({ posts: [post] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('parent1');
  });
});

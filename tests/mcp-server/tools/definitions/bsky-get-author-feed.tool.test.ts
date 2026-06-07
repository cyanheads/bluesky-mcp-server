/**
 * @fileoverview Tests for bsky_get_author_feed tool.
 * @module tests/mcp-server/tools/definitions/bsky-get-author-feed.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { AuthorFeedResult, PostView } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePost = (overrides: Partial<PostView> = {}): PostView => ({
  uri: 'at://did:plc:abc/app.bsky.feed.post/rkey1',
  cid: 'bafyr1',
  text: 'Hello from author feed',
  author: { did: 'did:plc:abc', handle: 'alice.bsky.social', displayName: 'Alice' },
  likeCount: 10,
  repostCount: 3,
  replyCount: 2,
  createdAt: '2025-01-02T00:00:00Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockGetAuthorFeed = vi.fn<[], Promise<AuthorFeedResult>>();

vi.mock('@/services/bluesky/bluesky-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/services/bluesky/bluesky-service.js')>();
  return {
    ...orig,
    getBlueskyService: () => ({ getAuthorFeed: mockGetAuthorFeed }),
  };
});

// ---------------------------------------------------------------------------

describe('bskyGetAuthorFeed', () => {
  beforeEach(() => {
    initBlueskyService();
    mockGetAuthorFeed.mockReset();
  });

  // --- Happy path ---

  it('returns posts for a valid actor', async () => {
    mockGetAuthorFeed.mockResolvedValue({ feed: [makePost()] });

    const ctx = createMockContext();
    const input = bskyGetAuthorFeed.input.parse({ actor: 'alice.bsky.social' });
    const result = await bskyGetAuthorFeed.handler(input, ctx);

    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].text).toBe('Hello from author feed');
    expect(result.cursor).toBeUndefined();
  });

  it('applies default filter posts_no_replies', () => {
    const input = bskyGetAuthorFeed.input.parse({ actor: 'alice.bsky.social' });
    expect(input.filter).toBe('posts_no_replies');
  });

  // --- Cursor pagination ---

  it('passes cursor to next page', async () => {
    mockGetAuthorFeed.mockResolvedValue({ feed: [makePost()], cursor: 'cursor-abc' });

    const ctx = createMockContext();
    const input = bskyGetAuthorFeed.input.parse({
      actor: 'alice.bsky.social',
      cursor: 'prev-cursor',
    });
    const result = await bskyGetAuthorFeed.handler(input, ctx);

    expect(result.cursor).toBe('cursor-abc');
  });

  // --- Empty feed ---

  it('returns empty posts array', async () => {
    mockGetAuthorFeed.mockResolvedValue({ feed: [] });

    const ctx = createMockContext();
    const input = bskyGetAuthorFeed.input.parse({ actor: 'empty.bsky.social' });
    const result = await bskyGetAuthorFeed.handler(input, ctx);

    expect(result.posts).toHaveLength(0);
  });

  it('calls ctx.enrich.notice on empty feed', async () => {
    mockGetAuthorFeed.mockResolvedValue({ feed: [] });

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskyGetAuthorFeed.input.parse({ actor: 'empty.bsky.social' });
    await bskyGetAuthorFeed.handler(input, ctx);

    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0][0]).toContain('empty.bsky.social');
  });

  it('does not call ctx.enrich.notice when posts are returned', async () => {
    mockGetAuthorFeed.mockResolvedValue({ feed: [makePost()] });

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskyGetAuthorFeed.input.parse({ actor: 'alice.bsky.social' });
    await bskyGetAuthorFeed.handler(input, ctx);

    expect(noticeSpy).not.toHaveBeenCalled();
  });

  // --- Error contract ---

  it('translates upstream 400 "Profile not found" to actor_not_found', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetAuthorFeed.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        responseBody: '{"error":"InvalidRequest","message":"Profile not found"}',
        errorSource: 'FetchHttpError',
      }),
    );

    const ctx = createMockContext({ errors: bskyGetAuthorFeed.errors });
    const input = bskyGetAuthorFeed.input.parse({ actor: 'ghost.bsky.social' });

    await expect(bskyGetAuthorFeed.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'actor_not_found' }),
    });
  });

  // --- format() ---

  it('renders AT-URI and author handle for each post', () => {
    const output = { posts: [makePost()] };
    const blocks = bskyGetAuthorFeed.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('at://did:plc:abc/app.bsky.feed.post/rkey1');
    expect(text).toContain('Alice');
    expect(text).toContain('alice.bsky.social');
  });

  it('renders empty message when no posts', () => {
    const blocks = bskyGetAuthorFeed.format!({ posts: [] });
    expect((blocks[0] as { text: string }).text).toContain('No posts');
  });

  it('renders cursor in footer', () => {
    const blocks = bskyGetAuthorFeed.format!({ posts: [makePost()], cursor: 'next-tok' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('next-tok');
  });

  it('renders reply-to AT-URI when present', () => {
    const post = makePost({ replyToUri: 'at://did:plc:abc/app.bsky.feed.post/parent1' });
    const blocks = bskyGetAuthorFeed.format!({ posts: [post] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('parent1');
  });
});

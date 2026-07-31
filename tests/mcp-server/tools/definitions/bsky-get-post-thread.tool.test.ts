/**
 * @fileoverview Tests for bsky_get_post_thread tool — AT-URI validation, thread shaping, format.
 * @module tests/mcp-server/tools/definitions/bsky-get-post-thread.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { ThreadPost } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT_POST: ThreadPost['post'] = {
  uri: 'at://did:plc:abc/app.bsky.feed.post/root1',
  cid: 'bafyrroot',
  text: 'Root post text',
  author: { did: 'did:plc:abc', handle: 'alice.bsky.social', displayName: 'Alice' },
  likeCount: 20,
  replyCount: 3,
  createdAt: '2025-01-01T00:00:00Z',
};

const REPLY_POST: ThreadPost['post'] = {
  uri: 'at://did:plc:def/app.bsky.feed.post/reply1',
  cid: 'bafyrreply',
  text: 'Reply text',
  author: { did: 'did:plc:def', handle: 'bob.bsky.social', displayName: 'Bob' },
};

const makeThread = (overrides: Partial<ThreadPost> = {}): ThreadPost => ({
  post: ROOT_POST,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockGetPostThread = vi.fn<[], Promise<ThreadPost>>();

vi.mock('@/services/bluesky/bluesky-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/services/bluesky/bluesky-service.js')>();
  return {
    ...orig,
    getBlueskyService: () => ({ getPostThread: mockGetPostThread }),
  };
});

// ---------------------------------------------------------------------------

describe('bskyGetPostThread', () => {
  beforeEach(() => {
    initBlueskyService();
    mockGetPostThread.mockReset();
  });

  // --- Post not found (typed contract, upstream translation) ---

  it('translates upstream 404 "Post not found" to post_not_found', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetPostThread.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 400', {
        responseBody: '{"error":"NotFound","message":"Post not found: at://..."}',
        errorSource: 'FetchHttpError',
      }),
    );

    const ctx = createMockContext({ errors: bskyGetPostThread.errors });
    const input = bskyGetPostThread.input.parse({
      uri: 'at://did:plc:abc/app.bsky.feed.post/deleted',
    });

    await expect(bskyGetPostThread.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'post_not_found' }),
    });
  });

  // --- AT-URI validation (schema layer, before the upstream call) ---

  it.each([
    ['blank', ''],
    ['authority only', 'at://bad'],
    ['https URL', 'https://bsky.app/post/abc'],
    ['missing at:// prefix', 'did:plc:abc/app.bsky.feed.post/r1'],
    ['missing record key', 'at://did:plc:abc/app.bsky.feed.post'],
    ['missing collection and record key', 'at://did:plc:abc'],
    ['collection without a dot', 'at://did:plc:abc/post/r1'],
    ['handle authority without a dot', 'at://alice/app.bsky.feed.post/r1'],
    ['trailing slash', 'at://did:plc:abc/app.bsky.feed.post/r1/'],
    ['whitespace in record key', 'at://did:plc:abc/app.bsky.feed.post/r 1'],
  ])('rejects a malformed AT-URI (%s) at the schema layer', (_label, uri) => {
    expect(() => bskyGetPostThread.input.parse({ uri })).toThrow();
    expect(mockGetPostThread).not.toHaveBeenCalled();
  });

  it.each([
    ['did:plc authority', 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3lc4gpsxr3c2q'],
    ['handle authority', 'at://bsky.app/app.bsky.feed.post/3lc4gpsxr3c2q'],
    ['did:web authority', 'at://did:web:example.com/app.bsky.feed.post/abc'],
    ['record key with punctuation', 'at://did:plc:abc/app.bsky.feed.post/a.b_c~d-e'],
  ])('accepts a well-formed AT-URI (%s)', (_label, uri) => {
    expect(bskyGetPostThread.input.parse({ uri }).uri).toBe(uri);
  });

  it('translates an upstream "Invalid at-uri" rejection to invalid_at_uri', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetPostThread.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ValidationError, 'Fetch failed. Status: 400', {
        responseBody:
          '{"error":"InvalidRequest","message":"Invalid app.bsky.feed.getPostThread params: Invalid at-uri"}',
        errorSource: 'FetchHttpError',
      }),
    );

    const ctx = createMockContext({ errors: bskyGetPostThread.errors });
    const input = bskyGetPostThread.input.parse({
      uri: 'at://did:example:odd/app.bsky.feed.post/r1',
    });

    await expect(bskyGetPostThread.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: expect.objectContaining({ reason: 'invalid_at_uri' }),
    });
  });

  // --- Happy path ---

  it('returns thread for valid AT-URI', async () => {
    mockGetPostThread.mockResolvedValue(makeThread());

    const ctx = createMockContext({ errors: bskyGetPostThread.errors });
    const input = bskyGetPostThread.input.parse({
      uri: 'at://did:plc:abc/app.bsky.feed.post/root1',
    });
    const result = await bskyGetPostThread.handler(input, ctx);

    expect(result.thread).toBeDefined();
    const thread = result.thread as ThreadPost;
    expect(thread.post.uri).toBe(ROOT_POST.uri);
    expect(thread.post.text).toBe('Root post text');
  });

  it('applies default depth=6 and parent_height=80', () => {
    const input = bskyGetPostThread.input.parse({
      uri: 'at://did:plc:abc/app.bsky.feed.post/r1',
    });
    expect(input.depth).toBe(6);
    expect(input.parent_height).toBe(80);
  });

  // --- Thread structure (parent chain + reply tree) ---

  it('returns thread with parent chain attached', async () => {
    const thread: ThreadPost = {
      post: ROOT_POST,
      parent: {
        post: {
          uri: 'at://did:plc:x/app.bsky.feed.post/grandparent',
          cid: 'bafyrgp',
          text: 'Grandparent post',
          author: { did: 'did:plc:x', handle: 'carol.bsky.social' },
        },
      },
    };
    mockGetPostThread.mockResolvedValue(thread);

    const ctx = createMockContext({ errors: bskyGetPostThread.errors });
    const input = bskyGetPostThread.input.parse({
      uri: 'at://did:plc:abc/app.bsky.feed.post/root1',
    });
    const result = await bskyGetPostThread.handler(input, ctx);
    const resultThread = result.thread as ThreadPost;
    expect(resultThread.parent).toBeDefined();
  });

  it('returns thread with nested replies', async () => {
    const thread: ThreadPost = {
      post: ROOT_POST,
      replies: [{ post: REPLY_POST }],
    };
    mockGetPostThread.mockResolvedValue(thread);

    const ctx = createMockContext({ errors: bskyGetPostThread.errors });
    const input = bskyGetPostThread.input.parse({
      uri: 'at://did:plc:abc/app.bsky.feed.post/root1',
    });
    const result = await bskyGetPostThread.handler(input, ctx);
    const resultThread = result.thread as ThreadPost;
    expect(Array.isArray(resultThread.replies)).toBe(true);
    expect((resultThread.replies as ThreadPost[]).length).toBe(1);
  });

  // --- Truncated node ---

  it('handles truncated reply node', async () => {
    const thread: ThreadPost = {
      post: ROOT_POST,
      replies: [
        { post: { uri: '', cid: '', text: '', author: { did: '', handle: '' } }, truncated: true },
      ],
    };
    mockGetPostThread.mockResolvedValue(thread);

    const ctx = createMockContext({ errors: bskyGetPostThread.errors });
    const input = bskyGetPostThread.input.parse({
      uri: 'at://did:plc:abc/app.bsky.feed.post/root1',
    });
    const result = await bskyGetPostThread.handler(input, ctx);
    const resultThread = result.thread as ThreadPost;
    expect((resultThread.replies as ThreadPost[])[0].truncated).toBe(true);
  });

  // --- format() ---

  it('renders root post text and AT-URI', () => {
    const thread = makeThread();
    const blocks = bskyGetPostThread.format!({ thread });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Root post text');
    expect(text).toContain('at://did:plc:abc/app.bsky.feed.post/root1');
  });

  it('renders "not found" fallback when thread is notFound', () => {
    const notFoundThread: ThreadPost = {
      post: { uri: '', cid: '', text: '', author: { did: '', handle: '' } },
      notFound: true,
    };
    const blocks = bskyGetPostThread.format!({ thread: notFoundThread });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('not found');
  });

  it('renders parent chain heading', () => {
    const thread: ThreadPost = {
      post: ROOT_POST,
      parent: {
        post: {
          uri: 'at://did:plc:x/app.bsky.feed.post/p1',
          cid: 'bafyrp1',
          text: 'Parent text',
          author: { did: 'did:plc:x', handle: 'x.bsky.social' },
        },
      },
    };
    const blocks = bskyGetPostThread.format!({ thread });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Parent chain');
    expect(text).toContain('Parent text');
  });

  it('renders replies heading', () => {
    const thread: ThreadPost = {
      post: ROOT_POST,
      replies: [{ post: REPLY_POST }],
    };
    const blocks = bskyGetPostThread.format!({ thread });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Replies');
    expect(text).toContain('Reply text');
  });

  it('renders truncated node indicator', () => {
    const thread: ThreadPost = {
      post: ROOT_POST,
      replies: [
        { post: { uri: '', cid: '', text: '', author: { did: '', handle: '' } }, truncated: true },
      ],
    };
    const blocks = bskyGetPostThread.format!({ thread });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('More replies');
  });
});

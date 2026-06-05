/**
 * @fileoverview Tests for bsky_get_profile tool.
 * @module tests/mcp-server/tools/definitions/bsky-get-profile.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyGetProfile } from '@/mcp-server/tools/definitions/bsky-get-profile.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { ActorProfile } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_PROFILE: ActorProfile = {
  did: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  handle: 'bsky.app',
  displayName: 'Bluesky',
  description: 'The Bluesky team.',
  avatar: 'https://cdn.bsky.app/img/avatar/bsky.jpg',
  followersCount: 500000,
  followsCount: 100,
  postsCount: 3000,
  createdAt: '2023-01-01T00:00:00Z',
  indexedAt: '2025-01-01T00:00:00Z',
  pinnedPostUri: 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/pinned1',
  labels: [{ val: 'official', src: 'did:plc:labeler' }],
};

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockGetProfile = vi.fn<[], Promise<ActorProfile>>();

vi.mock('@/services/bluesky/bluesky-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/services/bluesky/bluesky-service.js')>();
  return {
    ...orig,
    getBlueskyService: () => ({ getProfile: mockGetProfile }),
  };
});

// ---------------------------------------------------------------------------

describe('bskyGetProfile', () => {
  beforeEach(() => {
    initBlueskyService();
    mockGetProfile.mockReset();
  });

  // --- Happy path ---

  it('returns full profile for a valid handle', async () => {
    mockGetProfile.mockResolvedValue(FULL_PROFILE);

    const ctx = createMockContext();
    const input = bskyGetProfile.input.parse({ actor: 'bsky.app' });
    const result = await bskyGetProfile.handler(input, ctx);

    expect(result.did).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
    expect(result.handle).toBe('bsky.app');
    expect(result.followersCount).toBe(500000);
    expect(result.pinnedPostUri).toBe(
      'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/pinned1',
    );
  });

  it('accepts DID as actor input', async () => {
    mockGetProfile.mockResolvedValue(FULL_PROFILE);

    const ctx = createMockContext();
    const input = bskyGetProfile.input.parse({ actor: 'did:plc:z72i7hdynmk6r22z27h6tvur' });
    const result = await bskyGetProfile.handler(input, ctx);

    expect(result.did).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
  });

  // --- Actor not found (typed contract) ---

  it('translates upstream 400 "Profile not found" to actor_not_found', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetProfile.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        responseBody: '{"error":"InvalidRequest","message":"Profile not found"}',
        errorSource: 'FetchHttpError',
      }),
    );

    const ctx = createMockContext({ errors: bskyGetProfile.errors });
    const input = bskyGetProfile.input.parse({ actor: 'nonexistent.bsky.social' });

    await expect(bskyGetProfile.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'actor_not_found' }),
    });
  });

  it('propagates non-not-found McpErrors unchanged', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetProfile.mockRejectedValue(
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Upstream unavailable', {}),
    );

    const ctx = createMockContext({ errors: bskyGetProfile.errors });
    const input = bskyGetProfile.input.parse({ actor: 'bsky.app' });

    await expect(bskyGetProfile.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  // --- Sparse payload ---

  it('handles profile with only required fields', async () => {
    const sparse: ActorProfile = {
      did: 'did:plc:sparse',
      handle: 'sparse.bsky.social',
    };
    mockGetProfile.mockResolvedValue(sparse);

    const ctx = createMockContext();
    const input = bskyGetProfile.input.parse({ actor: 'sparse.bsky.social' });
    const result = await bskyGetProfile.handler(input, ctx);

    expect(result.displayName).toBeUndefined();
    expect(result.followersCount).toBeUndefined();
    expect(result.labels).toBeUndefined();
    // Schema must still parse cleanly
    expect(() => bskyGetProfile.output.parse(result)).not.toThrow();
  });

  // --- format() ---

  it('renders display name, handle, and DID', () => {
    const blocks = bskyGetProfile.format!(FULL_PROFILE);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Bluesky');
    expect(text).toContain('@bsky.app');
    expect(text).toContain('did:plc:z72i7hdynmk6r22z27h6tvur');
  });

  it('renders follower/following/post counts', () => {
    const blocks = bskyGetProfile.format!(FULL_PROFILE);
    const text = (blocks[0] as { text: string }).text;
    // Should surface counts in some form
    expect(text).toMatch(/500[,.]?000|500000/);
  });

  it('renders pinned post AT-URI', () => {
    const blocks = bskyGetProfile.format!(FULL_PROFILE);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/pinned1');
  });

  it('renders handle as display name fallback when displayName absent', () => {
    const profile: ActorProfile = { did: 'did:plc:x', handle: 'nodisplay.bsky.social' };
    const blocks = bskyGetProfile.format!(profile);
    const text = (blocks[0] as { text: string }).text;
    // handle should appear as the heading
    expect(text).toContain('nodisplay.bsky.social');
  });

  it('renders labels when present', () => {
    const blocks = bskyGetProfile.format!(FULL_PROFILE);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('official');
  });
});

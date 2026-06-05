/**
 * @fileoverview Tests for bsky-profile resource.
 * @module tests/mcp-server/resources/definitions/bsky-profile.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyProfileResource } from '@/mcp-server/resources/definitions/bsky-profile.resource.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { ActorProfile } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE: ActorProfile = {
  did: 'did:plc:z72i7hdynmk6r22z27h6tvur',
  handle: 'bsky.app',
  displayName: 'Bluesky',
  description: 'Official Bluesky account.',
  followersCount: 500000,
  followsCount: 100,
  postsCount: 3000,
  createdAt: '2023-01-01T00:00:00Z',
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

describe('bskyProfileResource', () => {
  beforeEach(() => {
    initBlueskyService();
    mockGetProfile.mockReset();
  });

  // --- Happy path ---

  it('returns profile data for a valid handle', async () => {
    mockGetProfile.mockResolvedValue(PROFILE);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = bskyProfileResource.params.parse({ actor: 'bsky.app' });
    const result = await bskyProfileResource.handler(params, ctx);

    expect((result as ActorProfile).did).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
    expect((result as ActorProfile).handle).toBe('bsky.app');
    expect((result as ActorProfile).displayName).toBe('Bluesky');
  });

  it('accepts DID as actor parameter', async () => {
    mockGetProfile.mockResolvedValue(PROFILE);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = bskyProfileResource.params.parse({ actor: 'did:plc:z72i7hdynmk6r22z27h6tvur' });
    const result = await bskyProfileResource.handler(params, ctx);

    expect((result as ActorProfile).did).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
  });

  // --- Actor not found (error contract) ---

  it('propagates NotFound when profile does not exist', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetProfile.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Profile not found', {}),
    );

    const ctx = createMockContext({
      tenantId: 'test-tenant',
      errors: bskyProfileResource.errors,
    });
    const params = bskyProfileResource.params.parse({ actor: 'ghost.bsky.social' });

    await expect(bskyProfileResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  // --- list() ---

  it('provides a non-empty resource listing', async () => {
    const listing = await bskyProfileResource.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources.length).toBeGreaterThan(0);
    for (const r of listing.resources) {
      expect(r).toHaveProperty('uri');
      expect(r).toHaveProperty('name');
      expect(r.uri).toMatch(/^bsky:\/\/profile\//);
    }
  });

  // --- Sparse payload ---

  it('handles profile with only required fields', async () => {
    const sparse: ActorProfile = { did: 'did:plc:sparse', handle: 'sparse.bsky.social' };
    mockGetProfile.mockResolvedValue(sparse);

    const ctx = createMockContext({ tenantId: 'test-tenant' });
    const params = bskyProfileResource.params.parse({ actor: 'sparse.bsky.social' });
    const result = await bskyProfileResource.handler(params, ctx);

    expect((result as ActorProfile).did).toBe('did:plc:sparse');
    expect((result as ActorProfile).followersCount).toBeUndefined();
  });
});

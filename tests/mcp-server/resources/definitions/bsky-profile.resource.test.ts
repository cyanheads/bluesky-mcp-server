/**
 * @fileoverview Tests for bsky-profile resource.
 * @module tests/mcp-server/resources/definitions/bsky-profile.resource.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
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

/**
 * `params` is optional on every `ResourceDefinition`; this resource declares it,
 * so the schema is present on the definition object itself.
 */
const parseParams = (actor: string) => bskyProfileResource.params!.parse({ actor });

/** The mock context every handler call in this file runs on, carrying the typed `ctx.fail`. */
const handlerContext = () =>
  createMockContext({ tenantId: 'test-tenant', errors: bskyProfileResource.errors });

/**
 * `list` receives the SDK's `ServerContext`, not a handler `Context`. This
 * listing ignores it, so every sink is inert.
 */
const listContext = (): Parameters<NonNullable<typeof bskyProfileResource.list>>[0] => ({
  mcpReq: {
    id: 'test-request-id',
    method: 'resources/list',
    requestState: () => undefined,
    signal: new AbortController().signal,
    send: async () => {
      throw new Error('send is not stubbed for resource listing.');
    },
    notify: async () => {},
    log: async () => {},
    elicitInput: async () => {
      throw new Error('elicitInput is not stubbed for resource listing.');
    },
    requestSampling: async () => {
      throw new Error('requestSampling is not stubbed for resource listing.');
    },
  },
});

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockGetProfile = vi.fn<(actor: string, ctx: Context) => Promise<ActorProfile>>();

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

    const ctx = handlerContext();
    const params = parseParams('bsky.app');
    const result = await bskyProfileResource.handler(params, ctx);

    expect((result as ActorProfile).did).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
    expect((result as ActorProfile).handle).toBe('bsky.app');
    expect((result as ActorProfile).displayName).toBe('Bluesky');
  });

  it('accepts DID as actor parameter', async () => {
    mockGetProfile.mockResolvedValue(PROFILE);

    const ctx = handlerContext();
    const params = parseParams('did:plc:z72i7hdynmk6r22z27h6tvur');
    const result = await bskyProfileResource.handler(params, ctx);

    expect((result as ActorProfile).did).toBe('did:plc:z72i7hdynmk6r22z27h6tvur');
  });

  // --- Actor not found (error contract) ---

  it('translates upstream 400 "Profile not found" to actor_not_found', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetProfile.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        responseBody: '{"error":"InvalidRequest","message":"Profile not found"}',
        errorSource: 'FetchHttpError',
      }),
    );

    const ctx = handlerContext();
    const params = parseParams('ghost.bsky.social');

    await expect(bskyProfileResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'actor_not_found' }),
    });
  });

  // --- list() ---

  it('provides a non-empty resource listing', async () => {
    const listing = await bskyProfileResource.list!(listContext());
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

    const ctx = handlerContext();
    const params = parseParams('sparse.bsky.social');
    const result = await bskyProfileResource.handler(params, ctx);

    expect((result as ActorProfile).did).toBe('did:plc:sparse');
    expect((result as ActorProfile).followersCount).toBeUndefined();
  });

  /** The resource is a second surface on the same profile and must not be thinner than the tool. */
  it('carries pronouns and website through to the injectable payload', async () => {
    mockGetProfile.mockResolvedValue({
      ...PROFILE,
      handle: 'nerdynanny.com',
      pronouns: 'they/he',
      website: 'https://nerdynanny.com',
    });

    const ctx = handlerContext();
    const params = parseParams('nerdynanny.com');
    const result = (await bskyProfileResource.handler(params, ctx)) as ActorProfile;

    expect(result.pronouns).toBe('they/he');
    expect(result.website).toBe('https://nerdynanny.com');
  });

  it('omits both for an account that set neither', async () => {
    mockGetProfile.mockResolvedValue(PROFILE);

    const ctx = handlerContext();
    const params = parseParams('bsky.app');
    const result = (await bskyProfileResource.handler(params, ctx)) as ActorProfile;

    expect(result).not.toHaveProperty('pronouns');
    expect(result).not.toHaveProperty('website');
  });

  // --- Actor validation (params layer, before the upstream call) ---

  it.each([
    ['blank', ''],
    ['whitespace only', '   '],
    ['bare name without a dot', 'alice'],
    ['@ before a DID', '@did:plc:z72i7hdynmk6r22z27h6tvur'],
  ])('rejects a malformed actor (%s) at the params layer', (_label, actor) => {
    expect(() => parseParams(actor)).toThrow();
    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it.each([
    ['handle', 'bsky.app'],
    ['did:plc', 'did:plc:z72i7hdynmk6r22z27h6tvur'],
  ])('accepts a valid actor (%s)', (_label, actor) => {
    expect(parseParams(actor).actor).toBe(actor);
  });
});

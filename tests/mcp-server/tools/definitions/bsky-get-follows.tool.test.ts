/**
 * @fileoverview Tests for bsky_get_follows tool — followers and following directions.
 * @module tests/mcp-server/tools/definitions/bsky-get-follows.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { ActorProfile, GraphResult } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUBJECT: ActorProfile = {
  did: 'did:plc:subject',
  handle: 'alice.bsky.social',
  displayName: 'Alice',
  followersCount: 500,
  followsCount: 100,
};

const FOLLOWER: ActorProfile = {
  did: 'did:plc:follower1',
  handle: 'bob.bsky.social',
  displayName: 'Bob',
  followersCount: 50,
};

const makeGraphResult = (overrides: Partial<GraphResult> = {}): GraphResult => ({
  actors: [FOLLOWER],
  subject: SUBJECT,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock — supports both getFollowers and getFollows paths
// ---------------------------------------------------------------------------

const mockGetFollowers = vi.fn<[], Promise<GraphResult>>();
const mockGetFollows = vi.fn<[], Promise<GraphResult>>();

vi.mock('@/services/bluesky/bluesky-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/services/bluesky/bluesky-service.js')>();
  return {
    ...orig,
    getBlueskyService: () => ({
      getFollowers: mockGetFollowers,
      getFollows: mockGetFollows,
    }),
  };
});

// ---------------------------------------------------------------------------

describe('bskyGetFollows', () => {
  beforeEach(() => {
    initBlueskyService();
    mockGetFollowers.mockReset();
    mockGetFollows.mockReset();
  });

  // --- Followers direction ---

  it('returns followers list with subject summary', async () => {
    mockGetFollowers.mockResolvedValue(makeGraphResult());

    const ctx = createMockContext();
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'followers',
    });
    const result = await bskyGetFollows.handler(input, ctx);

    expect(result.actors).toHaveLength(1);
    expect(result.actors[0].handle).toBe('bob.bsky.social');
    expect(result.subject.did).toBe('did:plc:subject');
    expect(result.subject.handle).toBe('alice.bsky.social');
    expect(result.subject.followersCount).toBe(500);
  });

  it('calls getFollowers service method for direction=followers', async () => {
    mockGetFollowers.mockResolvedValue(makeGraphResult());

    const ctx = createMockContext();
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'followers',
    });
    await bskyGetFollows.handler(input, ctx);

    expect(mockGetFollowers).toHaveBeenCalledOnce();
    expect(mockGetFollows).not.toHaveBeenCalled();
  });

  // --- Following direction ---

  it('calls getFollows service method for direction=following', async () => {
    mockGetFollows.mockResolvedValue(makeGraphResult());

    const ctx = createMockContext();
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'following',
    });
    await bskyGetFollows.handler(input, ctx);

    expect(mockGetFollows).toHaveBeenCalledOnce();
    expect(mockGetFollowers).not.toHaveBeenCalled();
  });

  // --- Cursor pagination ---

  it('passes cursor through', async () => {
    mockGetFollowers.mockResolvedValue(makeGraphResult({ cursor: 'next-cursor' }));

    const ctx = createMockContext();
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'followers',
      cursor: 'prev-cursor',
    });
    const result = await bskyGetFollows.handler(input, ctx);

    expect(result.cursor).toBe('next-cursor');
  });

  // --- Actor not found ---

  it('translates upstream 400 "Actor not found" to actor_not_found', async () => {
    const { McpError } = await import('@cyanheads/mcp-ts-core/errors');
    mockGetFollowers.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        responseBody: '{"error":"InvalidRequest","message":"Actor not found: ghost.bsky.social"}',
        errorSource: 'FetchHttpError',
      }),
    );

    const ctx = createMockContext({ errors: bskyGetFollows.errors });
    const input = bskyGetFollows.input.parse({
      actor: 'ghost.bsky.social',
      direction: 'followers',
    });

    await expect(bskyGetFollows.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: expect.objectContaining({ reason: 'actor_not_found' }),
    });
  });

  // --- Empty results ---

  it('returns empty actors array when no connections', async () => {
    mockGetFollowers.mockResolvedValue(makeGraphResult({ actors: [] }));

    const ctx = createMockContext();
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'followers',
    });
    const result = await bskyGetFollows.handler(input, ctx);

    expect(result.actors).toHaveLength(0);
  });

  // --- Sparse subject ---

  it('handles subject with only did and handle', async () => {
    const sparseSubject: ActorProfile = { did: 'did:plc:sparse', handle: 'sparse.bsky.social' };
    mockGetFollowers.mockResolvedValue(makeGraphResult({ subject: sparseSubject }));

    const ctx = createMockContext();
    const input = bskyGetFollows.input.parse({
      actor: 'sparse.bsky.social',
      direction: 'followers',
    });
    const result = await bskyGetFollows.handler(input, ctx);

    expect(result.subject.followersCount).toBeUndefined();
    expect(result.subject.followsCount).toBeUndefined();
  });

  // --- format() ---

  it('renders subject summary with handle and DID', () => {
    const output = {
      actors: [FOLLOWER],
      subject: SUBJECT,
    };
    const blocks = bskyGetFollows.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('alice.bsky.social');
    expect(text).toContain('did:plc:subject');
  });

  it('renders actor handles in the list', () => {
    const output = { actors: [FOLLOWER], subject: SUBJECT };
    const blocks = bskyGetFollows.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('bob.bsky.social');
    expect(text).toContain('did:plc:follower1');
  });

  it('renders empty actors message with subject header', () => {
    const output = { actors: [], subject: SUBJECT };
    const blocks = bskyGetFollows.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('alice.bsky.social');
    expect(text).toContain('No accounts');
  });

  it('renders cursor in footer', () => {
    const output = { actors: [FOLLOWER], subject: SUBJECT, cursor: 'page2' };
    const blocks = bskyGetFollows.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('page2');
  });
});

/**
 * @fileoverview Tests for bsky_search_actors tool.
 * @module tests/mcp-server/tools/definitions/bsky-search-actors.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { ActorProfile, SearchActorsResult } from '@/services/bluesky/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeActor = (overrides: Partial<ActorProfile> = {}): ActorProfile => ({
  did: 'did:plc:abc',
  handle: 'alice.bsky.social',
  displayName: 'Alice',
  description: 'About Alice',
  followersCount: 100,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockSearchActors = vi.fn<[], Promise<SearchActorsResult>>();

vi.mock('@/services/bluesky/bluesky-service.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/services/bluesky/bluesky-service.js')>();
  return {
    ...orig,
    getBlueskyService: () => ({ searchActors: mockSearchActors }),
  };
});

// ---------------------------------------------------------------------------

describe('bskySearchActors', () => {
  beforeEach(() => {
    initBlueskyService();
    mockSearchActors.mockReset();
  });

  // --- Happy path ---

  it('returns matching actors', async () => {
    mockSearchActors.mockResolvedValue({ actors: [makeActor()] });

    const ctx = createMockContext();
    const input = bskySearchActors.input.parse({ query: 'alice' });
    const result = await bskySearchActors.handler(input, ctx);

    expect(result.actors).toHaveLength(1);
    expect(result.actors[0].handle).toBe('alice.bsky.social');
    expect(result.actors[0].did).toBe('did:plc:abc');
  });

  it('applies default limit=25', () => {
    const input = bskySearchActors.input.parse({ query: 'test' });
    expect(input.limit).toBe(25);
  });

  // --- Empty results ---

  it('returns empty actors array', async () => {
    mockSearchActors.mockResolvedValue({ actors: [] });

    const ctx = createMockContext();
    const input = bskySearchActors.input.parse({ query: 'xyznotexist999' });
    const result = await bskySearchActors.handler(input, ctx);

    expect(result.actors).toHaveLength(0);
  });

  it('calls ctx.enrich.notice on empty results', async () => {
    mockSearchActors.mockResolvedValue({ actors: [] });

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskySearchActors.input.parse({ query: 'xyznotexist999' });
    await bskySearchActors.handler(input, ctx);

    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0][0]).toContain('xyznotexist999');
  });

  it('does not call ctx.enrich.notice when actors are returned', async () => {
    mockSearchActors.mockResolvedValue({ actors: [makeActor()] });

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskySearchActors.input.parse({ query: 'alice' });
    await bskySearchActors.handler(input, ctx);

    expect(noticeSpy).not.toHaveBeenCalled();
  });

  // --- Cursor pagination ---

  it('passes opaque cursor to next page', async () => {
    mockSearchActors.mockResolvedValue({ actors: [makeActor()], cursor: 'cursor-xyz' });

    const ctx = createMockContext();
    const input = bskySearchActors.input.parse({ query: 'alice', cursor: 'prev-cursor' });
    const result = await bskySearchActors.handler(input, ctx);

    expect(result.cursor).toBe('cursor-xyz');
  });

  // --- Sparse upstream payload ---

  it('handles actor with no optional fields', async () => {
    const sparse: ActorProfile = { did: 'did:plc:sparse', handle: 'sparse.bsky.social' };
    mockSearchActors.mockResolvedValue({ actors: [sparse] });

    const ctx = createMockContext();
    const input = bskySearchActors.input.parse({ query: 'sparse' });
    const result = await bskySearchActors.handler(input, ctx);

    expect(result.actors[0].displayName).toBeUndefined();
    expect(result.actors[0].followersCount).toBeUndefined();
    expect(() => bskySearchActors.output.parse(result)).not.toThrow();
  });

  // --- format() ---

  it('renders handle, DID, and displayName', () => {
    const output = { actors: [makeActor()] };
    const blocks = bskySearchActors.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('@alice.bsky.social');
    expect(text).toContain('did:plc:abc');
    expect(text).toContain('Alice');
  });

  it('renders follower count', () => {
    const blocks = bskySearchActors.format!({ actors: [makeActor()] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toMatch(/100/);
  });

  it('renders empty message when no actors', () => {
    const blocks = bskySearchActors.format!({ actors: [] });
    expect((blocks[0] as { text: string }).text).toContain('No');
  });

  it('renders cursor in footer', () => {
    const blocks = bskySearchActors.format!({ actors: [makeActor()], cursor: 'tok123' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('tok123');
  });
});

/**
 * @fileoverview Tests for bsky_search_actors tool.
 * @module tests/mcp-server/tools/definitions/bsky-search-actors.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
  ...overrides,
});

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

const mockSearchActors =
  vi.fn<
    (
      params: { q: string; limit?: number; cursor?: string },
      ctx: Context,
    ) => Promise<SearchActorsResult>
  >();

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
    expect(result.actors[0]).toMatchObject({
      handle: 'alice.bsky.social',
      did: 'did:plc:abc',
    });
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

  it('enriches an empty result with a notice naming the query', async () => {
    mockSearchActors.mockResolvedValue({ actors: [] });

    const ctx = createMockContext();
    const input = bskySearchActors.input.parse({ query: 'xyznotexist999' });
    await bskySearchActors.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('xyznotexist999');
  });

  it('enriches no notice when actors are returned', async () => {
    mockSearchActors.mockResolvedValue({ actors: [makeActor()] });

    const ctx = createMockContext();
    const input = bskySearchActors.input.parse({ query: 'alice' });
    await bskySearchActors.handler(input, ctx);

    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
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

    const [actor] = result.actors;
    expect(actor).toBeDefined();
    expect(actor?.displayName).toBeUndefined();
    expect(actor?.description).toBeUndefined();
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

  it('renders no follower line — profileView carries no counts', () => {
    const text = (bskySearchActors.format!({ actors: [makeActor()] })[0] as { text: string }).text;
    expect(text).not.toContain('Followers');
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

  it('frames each bio as a blockquote', () => {
    const text = (bskySearchActors.format!({ actors: [makeActor()] })[0] as { text: string }).text;
    expect(text).toContain('> About Alice');
    expect(text.split('\n')).not.toContain('About Alice');
  });

  it('keeps a two-line display name on the name line', () => {
    const actor = makeActor({ displayName: 'Alice\n## @admin.bsky.social' });
    const lines = (bskySearchActors.format!({ actors: [actor] })[0] as { text: string }).text.split(
      '\n',
    );
    expect(lines).toContain('**Name:** Alice ## @admin.bsky.social');
    expect(lines).not.toContain('## @admin.bsky.social');
  });

  // --- Pronouns ---

  /**
   * `profileView` declares `pronouns` and searchActors returns it, so dropping it at the schema
   * layer costs a per-account round trip to recover a string the response already carried.
   */
  it('carries pronouns through both channels when the account set them', () => {
    const actor = makeActor({ pronouns: 'they/he' });
    const parsed = bskySearchActors.output.parse({ actors: [actor] });
    const lines = (bskySearchActors.format!({ actors: [actor] })[0] as { text: string }).text.split(
      '\n',
    );

    expect(parsed.actors[0]).toMatchObject({ pronouns: 'they/he' });
    expect(lines).toContain('**Pronouns:** they/he');
  });

  it('renders no pronouns line for an account that set none', () => {
    const text = (bskySearchActors.format!({ actors: [makeActor()] })[0] as { text: string }).text;

    expect(text).not.toContain('**Pronouns:**');
  });

  it('keeps a pronouns value from breaking out of the line it labels', () => {
    const actor = makeActor({ pronouns: 'they/them\n## @admin.bsky.social' });
    const lines = (bskySearchActors.format!({ actors: [actor] })[0] as { text: string }).text.split(
      '\n',
    );

    expect(lines).toContain('**Pronouns:** they/them ## @admin.bsky.social');
    expect(lines).not.toContain('## @admin.bsky.social');
  });

  it("keeps a bio's own heading from merging with the actor headings", () => {
    const actor = makeActor({
      description: 'Digital artists unite!\n---\n## Contact\nhi@x.example',
    });
    const lines = (bskySearchActors.format!({ actors: [actor] })[0] as { text: string }).text.split(
      '\n',
    );
    expect(lines).not.toContain('---');
    expect(lines).not.toContain('## Contact');
    expect(lines).toContain('> ---');
    expect(lines).toContain('> ## Contact');
  });

  // --- Query validation (schema layer, before the upstream call) ---

  it.each([
    ['blank', ''],
    ['single space', ' '],
    ['whitespace only', '  \t\n '],
  ])('rejects a blank query (%s) at the schema layer', (_label, query) => {
    expect(() => bskySearchActors.input.parse({ query })).toThrow();
    expect(mockSearchActors).not.toHaveBeenCalled();
  });

  it('accepts a query with surrounding whitespace around real content', () => {
    expect(bskySearchActors.input.parse({ query: ' alice ' }).query).toBe(' alice ');
  });
});

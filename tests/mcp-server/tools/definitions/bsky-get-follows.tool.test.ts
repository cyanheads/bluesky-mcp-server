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

  it('calls ctx.enrich.notice on empty actors list', async () => {
    mockGetFollowers.mockResolvedValue(makeGraphResult({ actors: [] }));

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'followers',
    });
    await bskyGetFollows.handler(input, ctx);

    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0][0]).toContain('alice.bsky.social');
  });

  it('does not call ctx.enrich.notice when actors are returned', async () => {
    mockGetFollowers.mockResolvedValue(makeGraphResult());

    const ctx = createMockContext();
    const noticeSpy = vi.spyOn(
      ctx.enrich as unknown as { notice: (msg: string) => void },
      'notice',
    );
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'followers',
    });
    await bskyGetFollows.handler(input, ctx);

    expect(noticeSpy).not.toHaveBeenCalled();
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

  it('frames each bio as a blockquote', () => {
    const actor: ActorProfile = { ...FOLLOWER, description: 'About Bob' };
    const text = (
      bskyGetFollows.format!({ actors: [actor], subject: SUBJECT })[0] as { text: string }
    ).text;
    expect(text).toContain('> About Bob');
    expect(text.split('\n')).not.toContain('About Bob');
  });

  it('keeps two-line display names on the subject and actor lines', () => {
    const subject: ActorProfile = { ...SUBJECT, displayName: 'Alice\n## @admin.bsky.social' };
    const actor: ActorProfile = { ...FOLLOWER, displayName: 'Bob\n---' };
    const lines = (
      bskyGetFollows.format!({ actors: [actor], subject })[0] as { text: string }
    ).text.split('\n');
    expect(lines).toContain('## Subject: Alice ## @admin.bsky.social (@alice.bsky.social)');
    expect(lines).toContain('**Name:** Bob ---');
    /** The only bare `---` is the one format() writes between the subject header and the list. */
    expect(lines.filter((l) => l === '---')).toHaveLength(1);
  });

  it("keeps a bio's own heading and rule from merging with the actor list", () => {
    const actor: ActorProfile = {
      ...FOLLOWER,
      description: 'Bio line.\n\n---\n\n### @admin.bsky.social\nnot a real entry',
    };
    const lines = (
      bskyGetFollows.format!({ actors: [actor], subject: SUBJECT })[0] as { text: string }
    ).text.split('\n');
    /** The only bare `---` is the one format() writes between the subject header and the list. */
    expect(lines.filter((l) => l === '---')).toHaveLength(1);
    expect(lines).not.toContain('### @admin.bsky.social');
    expect(lines).toContain('> ### @admin.bsky.social');
  });

  // --- Pronouns ---

  /**
   * `profileView` carries `pronouns` on both the list entries and the subject, and this tool
   * returns up to 100 accounts a page — the point at which a per-account profile lookup is the
   * expensive way to recover a string already in hand.
   */
  it('carries pronouns on the list entries and on the subject', async () => {
    mockGetFollowers.mockResolvedValue({
      actors: [{ ...FOLLOWER, pronouns: 'he/him' }],
      subject: { ...SUBJECT, pronouns: 'they/he' },
    });

    const ctx = createMockContext({ errors: bskyGetFollows.errors });
    const input = bskyGetFollows.input.parse({
      actor: 'alice.bsky.social',
      direction: 'followers',
    });
    const result = await bskyGetFollows.handler(input, ctx);

    expect(bskyGetFollows.output.parse(result)).toMatchObject({
      actors: [{ pronouns: 'he/him' }],
      subject: { pronouns: 'they/he' },
    });
    const lines = (bskyGetFollows.format!(result)[0] as { text: string }).text.split('\n');
    expect(lines.filter((l) => l === '**Pronouns:** they/he')).toHaveLength(1);
    expect(lines.filter((l) => l === '**Pronouns:** he/him')).toHaveLength(1);
  });

  it('renders no pronouns line for accounts that set none', () => {
    const text = (
      bskyGetFollows.format!({ actors: [FOLLOWER], subject: SUBJECT })[0] as { text: string }
    ).text;

    expect(text).not.toContain('**Pronouns:**');
  });

  it('keeps a pronouns value from breaking out of the line it labels', () => {
    const lines = (
      bskyGetFollows.format!({
        actors: [{ ...FOLLOWER, pronouns: 'he/him\n### @admin.bsky.social' }],
        subject: SUBJECT,
      })[0] as { text: string }
    ).text.split('\n');

    expect(lines).toContain('**Pronouns:** he/him ### @admin.bsky.social');
    expect(lines).not.toContain('### @admin.bsky.social');
  });

  // --- Actor validation (schema layer, before the upstream call) ---

  it.each([
    ['blank', ''],
    ['whitespace only', '   '],
    ['bare name without a dot', 'alice'],
    ['leading @', '@alice.bsky.social'],
    ['spaces', 'not a handle'],
  ])('rejects a malformed actor (%s) at the schema layer', (_label, actor) => {
    expect(() => bskyGetFollows.input.parse({ actor, direction: 'followers' })).toThrow();
    expect(mockGetFollowers).not.toHaveBeenCalled();
    expect(mockGetFollows).not.toHaveBeenCalled();
  });

  it.each([
    ['handle', 'alice.bsky.social'],
    ['did:plc', 'did:plc:z72i7hdynmk6r22z27h6tvur'],
  ])('accepts a valid actor (%s)', (_label, actor) => {
    expect(bskyGetFollows.input.parse({ actor, direction: 'following' }).actor).toBe(actor);
  });
});

/**
 * @fileoverview Unit tests for BlueskyService — normalization helpers.
 * @module tests/services/bluesky/bluesky-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlueskyService } from '@/services/bluesky/bluesky-service.js';

// ---------------------------------------------------------------------------
// Mock framework network helpers so no real HTTP is made.
// ---------------------------------------------------------------------------

vi.mock('@cyanheads/mcp-ts-core/utils', () => ({
  fetchWithTimeout: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';

const mockFetch = vi.mocked(fetchWithTimeout);

/** Return a fake Response-like object that resolves to the given JSON. */
function fakeResponse(body: unknown): ReturnType<typeof fetchWithTimeout> {
  return Promise.resolve({
    text: () => Promise.resolve(JSON.stringify(body)),
    status: 200,
    ok: true,
  } as unknown as Response) as ReturnType<typeof fetchWithTimeout>;
}

// ---------------------------------------------------------------------------

describe('BlueskyService.getTrends — link normalization', () => {
  let service: BlueskyService;

  beforeEach(() => {
    service = new BlueskyService();
    mockFetch.mockReset();
  });

  it('passes through an already-absolute link unchanged', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({
        trends: [
          {
            topic: 'ailaunch',
            displayName: 'AI Launch',
            link: 'https://bsky.app/search?q=ailaunch',
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const result = await service.getTrends({ limit: 1 }, ctx);
    expect(result.trends[0].link).toBe('https://bsky.app/search?q=ailaunch');
  });

  it('expands a relative path to https://bsky.app + path', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({
        trends: [
          {
            topic: 'trending',
            displayName: 'Trending',
            link: '/profile/trending.bsky.app/feed/747851028',
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const result = await service.getTrends({ limit: 1 }, ctx);
    expect(result.trends[0].link).toBe('https://bsky.app/profile/trending.bsky.app/feed/747851028');
  });

  it('omits link when API returns none', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({
        trends: [{ topic: 'nolink', displayName: 'No Link' }],
      }),
    );

    const ctx = createMockContext();
    const result = await service.getTrends({ limit: 1 }, ctx);
    expect(result.trends[0].link).toBeUndefined();
  });
});

/**
 * @fileoverview A response that fits the 48,000-byte budget is byte-for-byte what the server
 * returned before the budget existed. Each case runs one of the five post tools through the real
 * service over a faked `fetch` and compares a SHA-256 of both surfaces against a fingerprint taken
 * from the pre-budget build — the default page of each paged tool, a last page, an empty page, a
 * pinned first page, and a small thread with a parent chain.
 * @module tests/mcp-server/tools/response-budget.characterization.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskyGetPostQuotes } from '@/mcp-server/tools/definitions/bsky-get-post-quotes.tool.js';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import {
  AUTHOR_DID,
  buildTree,
  fingerprint,
  postUri,
  rawPost,
  routeAuthorFeed,
  routeQuotes,
  routeRankedFeed,
  routeSearch,
  routeThread,
  stream,
  surfaces,
} from './budget-fixtures.js';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
});

afterEach(() => {
  http.restore();
});

const FEED = `at://${AUTHOR_DID}/app.bsky.feed.generator/whats-hot`;
const BUDGET_KEYS = ['budgetCapped', 'budgetOmitted'];

/** Every case: the response fits, carries no budget field, and matches its pre-budget fingerprint. */
async function expectUnchanged(
  run: () => Promise<Parameters<typeof fingerprint>[0]>,
  expected: string,
) {
  const result = await run();
  expect((result as { isError?: boolean }).isError).toBeFalsy();
  const size = surfaces(result);
  expect(size.structured).toBeLessThanOrEqual(48_000);
  expect(size.content).toBeLessThanOrEqual(48_000);
  for (const key of BUDGET_KEYS) expect(result.structuredContent).not.toHaveProperty(key);
  expect(fingerprint(result)).toBe(expected);
}

describe('responses that fit are unchanged', () => {
  it('bsky_get_author_feed, the default page with a pin', async () => {
    routeAuthorFeed(http, stream(40, 400), rawPost(postUri('pinned'), { descriptionBytes: 400 }));
    await expectUnchanged(
      () => runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', include_pins: true }),
      'f73ebbeb207f042b67768917c3b10c5fc6e29ac24ab3bd69588e7a9ad316c88e',
    );
  });

  it('bsky_get_author_feed, a last page with no cursor', async () => {
    routeAuthorFeed(http, stream(40, 400));
    await expectUnchanged(
      () => runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', cursor: 'c30' }),
      'ed01b2392d29e81c3a60c38c46158f2814ada17e5ac0d28573784d55270a9325',
    );
  });

  it('bsky_get_feed, the default page', async () => {
    routeRankedFeed(http, (_call, limit) => ({ posts: stream(limit, 400), cursor: 'next' }));
    await expectUnchanged(
      () => runToolContract(bskyGetFeed, { feed: FEED }),
      '381640d5e9a53725dc189f890834092df7c15405c27ce798fef95884bee11987',
    );
  });

  it('bsky_get_feed, an empty feed', async () => {
    routeRankedFeed(http, () => ({ posts: [] }));
    await expectUnchanged(
      () => runToolContract(bskyGetFeed, { feed: FEED }),
      '567c950da1d470b8cefec6d673a7b34b8288873660cdefb77b5abf0bd4e554ac',
    );
  });

  it('bsky_get_post_quotes, the default page', async () => {
    routeQuotes(http, stream(40, 400));
    await expectUnchanged(
      () => runToolContract(bskyGetPostQuotes, { uri: postUri('quoted') }),
      '6493c9c3e69e6e8e1ba5a9163501d4cfd3bdd72aaba98ee079d216e865d63d7f',
    );
  });

  it('bsky_search_posts, the default page', async () => {
    routeSearch(http, stream(40, 400));
    await expectUnchanged(
      () => runToolContract(bskySearchPosts, { query: 'weather' }),
      '7cf660071a67dcfe81409b1444edb7c26814e93c429fd591802cc3829e086835',
    );
  });

  it('bsky_get_post_thread, a small thread with a parent chain', async () => {
    routeThread(http, buildTree({ branching: [3, 2], chain: 2, descriptionBytes: 400 }));
    await expectUnchanged(
      () => runToolContract(bskyGetPostThread, { uri: postUri('root') }),
      '8fa951ce03f63f39a476c38e3c02578ebd6743b0c4d73cc4f1d1c162812c457e',
    );
  });
});

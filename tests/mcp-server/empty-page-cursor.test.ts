/**
 * @fileoverview An empty page that still carries a cursor, on every list tool that renders one
 * itself: `content[]` must carry the cursor a `structuredContent` reader gets, and must not say the
 * list is empty when more can be fetched. Without a cursor, each tool keeps its empty wording. Run
 * through the real service over a faked global `fetch`.
 * @module tests/mcp-server/empty-page-cursor.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const NEXT = 'NEXT-CURSOR';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});

afterEach(() => {
  http.restore();
});

/** Every list endpoint answered with nothing on the page, and a cursor only when `cursor` is set. */
function routeEmpty(cursor?: string) {
  http.route({
    match: /^https:\/\/api\.bsky\.app\/xrpc\//,
    respond: () =>
      Response.json({
        feed: [],
        actors: [],
        follows: [],
        followers: [],
        subject: { did: DID, handle: 'bsky.app' },
        ...(cursor ? { cursor } : {}),
      }),
  });
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as { cursor?: string; truncated?: boolean; notice?: string };

const TOOLS = [
  {
    name: 'bsky_get_follows',
    run: () =>
      runToolContract(bskyGetFollows, { actor: 'bsky.app', direction: 'followers', cursor: 'c1' }),
    runFirst: () => runToolContract(bskyGetFollows, { actor: 'bsky.app', direction: 'followers' }),
    empty: '*No accounts on this page.*',
    exhausted: 'No followers found for actor "bsky.app".',
  },
  {
    name: 'bsky_get_feed',
    run: () =>
      runToolContract(bskyGetFeed, {
        feed: `at://${DID}/app.bsky.feed.generator/whats-hot`,
        cursor: 'c1',
      }),
    runFirst: () =>
      runToolContract(bskyGetFeed, { feed: `at://${DID}/app.bsky.feed.generator/whats-hot` }),
    empty: 'The feed returned no posts.',
    exhausted: 'The feed returned no posts.',
  },
  {
    name: 'bsky_get_author_feed',
    run: () => runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', cursor: 'c1' }),
    runFirst: () => runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' }),
    empty: 'No posts found for this actor.',
    exhausted: 'No posts found for actor "bsky.app"',
  },
  {
    name: 'bsky_search_actors',
    run: () => runToolContract(bskySearchActors, { query: 'bluesky', cursor: 'c1' }),
    runFirst: () => runToolContract(bskySearchActors, { query: 'bluesky' }),
    empty: 'No actors on this page.',
    exhausted: 'No actors matched "bluesky"',
  },
];

describe.each(TOOLS)('$name — an empty page', ({ run, runFirst, empty, exhausted }) => {
  it('renders the cursor it still carries in content[], and claims no end of the list', async () => {
    routeEmpty(NEXT);
    const result = await run();

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({ cursor: NEXT, truncated: true });
    expect(structured(result).notice).not.toContain(exhausted);
    const text = textOf(result);
    expect(text).toContain(`*cursor: \`${NEXT}\`*`);
    expect(text).not.toContain(exhausted);
  });

  it('keeps its empty wording when no cursor came back', async () => {
    routeEmpty();
    const result = await runFirst();

    expect(result.isError).toBeFalsy();
    expect(structured(result).cursor).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain(empty);
    expect(text).toContain(exhausted);
    expect(text).not.toContain('cursor: `');
  });
});

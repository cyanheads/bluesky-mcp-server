/**
 * @fileoverview Every actor, post, and feed input takes the forms a caller shares — `@handle`, a
 * bsky.app profile, post, or feed URL — and reaches Bluesky as the value it names. Run through the
 * real service over a faked global `fetch`, so the assertion is on the request that actually leaves:
 * one case per field, plus the error messages and notices, which name the rewritten value.
 * @module tests/mcp-server/input-forms.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyProfileResource } from '@/mcp-server/resources/definitions/bsky-profile.resource.js';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { bskyGetPostQuotes } from '@/mcp-server/tools/definitions/bsky-get-post-quotes.tool.js';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { bskyGetProfile } from '@/mcp-server/tools/definitions/bsky-get-profile.tool.js';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

const DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const RKEY = '3l6oveex3ii2l';
const PDS = 'https://pds.example.test';

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

type ErrorEnvelope = { code: number; message: string; data?: { reason?: string } };
const errorOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error: ErrorEnvelope }).error;
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');
const structured = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;

/** The query parameter `name` on the one request made to `lexicon`. */
function sentParam(lexicon: string, name: string): string | null {
  const calls = http.calls.filter((c) => new URL(c.request.url).pathname === `/xrpc/${lexicon}`);
  expect(calls).toHaveLength(1);
  return new URL(calls[0]?.request.url ?? '').searchParams.get(name);
}

const profileBody = () => Response.json({ did: DID, handle: 'bsky.app' });
const postView = (rkey: string) => ({
  uri: `at://${DID}/app.bsky.feed.post/${rkey}`,
  cid: `bafy${rkey}`,
  author: { did: DID, handle: 'bsky.app' },
  record: { text: `text ${rkey}` },
});
const graphBody = () =>
  Response.json({ follows: [], followers: [], subject: { did: DID, handle: 'bsky.app' } });

const ACTOR_FORMS = [
  ['a bare handle', 'bsky.app', 'bsky.app'],
  ['a DID', DID, DID],
  ['@handle', '@bsky.app', 'bsky.app'],
  ['a profile URL', 'https://bsky.app/profile/bsky.app', 'bsky.app'],
  ['a profile URL with a trailing slash', 'https://bsky.app/profile/bsky.app/', 'bsky.app'],
  ['a profile URL with a query', 'https://bsky.app/profile/bsky.app?ref=share', 'bsky.app'],
  ['a profile URL with a DID', `https://bsky.app/profile/${DID}#x`, DID],
] as const;

describe('actor fields', () => {
  it.each(ACTOR_FORMS)('bsky_get_profile reads %s as %s', async (_label, actor, sent) => {
    http.route({ match: /app\.bsky\.actor\.getProfile/, respond: profileBody });
    const result = await runToolContract(bskyGetProfile, { actor });
    expect(result.isError).toBeFalsy();
    expect(sentParam('app.bsky.actor.getProfile', 'actor')).toBe(sent);
  });

  it.each(ACTOR_FORMS)('bsky_get_author_feed reads %s', async (_label, actor, sent) => {
    http.route({
      match: /app\.bsky\.feed\.getAuthorFeed/,
      respond: () => Response.json({ feed: [] }),
    });
    const result = await runToolContract(bskyGetAuthorFeed, { actor });
    expect(sentParam('app.bsky.feed.getAuthorFeed', 'actor')).toBe(sent);
    expect(structured(result).notice).toContain(`"${sent}"`);
    expect(structured(result).notice).not.toContain('@bsky.app');
  });

  it.each(ACTOR_FORMS)('bsky_get_follows reads %s', async (_label, actor, sent) => {
    http.route({ match: /app\.bsky\.graph\.getFollows/, respond: graphBody });
    const result = await runToolContract(bskyGetFollows, { actor, direction: 'following' });
    expect(sentParam('app.bsky.graph.getFollows', 'actor')).toBe(sent);
    expect(structured(result).notice).toContain(`"${sent}"`);
  });

  it.each(ACTOR_FORMS)('bsky_search_posts author_handle reads %s', async (_label, actor, sent) => {
    http.route(
      {
        method: 'POST',
        match: 'https://bsky.social/xrpc/com.atproto.server.createSession',
        respond: () =>
          Response.json({
            accessJwt: 'a',
            refreshJwt: 'r',
            did: 'did:plc:operator',
            handle: 'operator.bsky.social',
            didDoc: {
              service: [
                { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
              ],
            },
          }),
      },
      {
        match: /app\.bsky\.feed\.searchPosts/,
        respond: () => Response.json({ posts: [], hitsTotal: 0 }),
      },
    );
    await runToolContract(bskySearchPosts, { query: 'x', author_handle: actor });
    expect(sentParam('app.bsky.feed.searchPosts', 'author')).toBe(sent);
  });

  it('bsky://profile/{actor} reads @handle as the handle', async () => {
    http.route({ match: /app\.bsky\.actor\.getProfile/, respond: profileBody });
    const params = bskyProfileResource.params?.parse({ actor: '@bsky.app' });
    const ctx = createMockContext({ errors: bskyProfileResource.errors });
    await expect(
      bskyProfileResource.handler(params as { actor: string }, ctx),
    ).resolves.toMatchObject({
      did: DID,
    });
    expect(sentParam('app.bsky.actor.getProfile', 'actor')).toBe('bsky.app');
  });

  it('actor_not_found names the handle, not the form it arrived in', async () => {
    http.route({
      match: /app\.bsky\.actor\.getProfile/,
      respond: () =>
        Response.json({ error: 'InvalidRequest', message: 'Profile not found' }, { status: 400 }),
    });
    const result = await runToolContract(bskyGetProfile, {
      actor: 'https://bsky.app/profile/ghost.bsky.social/',
    });
    expect(errorOf(result).data?.reason).toBe('actor_not_found');
    expect(errorOf(result).message).toBe('Actor not found: "ghost.bsky.social"');
  });

  it.each([
    ['a post URL', `https://bsky.app/profile/bsky.app/post/${RKEY}`],
    ['@ before a URL', '@https://bsky.app/profile/bsky.app'],
    ['a www host', 'https://www.bsky.app/profile/bsky.app'],
  ])('rejects %s before any request', async (_label, actor) => {
    const result = await runToolContract(bskyGetProfile, { actor });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(http.calls).toHaveLength(0);
  });
});

describe('bsky_get_post_thread uri', () => {
  const thread = () =>
    Response.json({ thread: { $type: 'app.bsky.feed.defs#threadViewPost', post: postView(RKEY) } });

  it.each([
    ['a handle-authority AT-URI, unchanged', `at://bsky.app/app.bsky.feed.post/${RKEY}`],
    ['a post URL', `https://bsky.app/profile/bsky.app/post/${RKEY}`],
    ['a post URL with a trailing slash', `https://bsky.app/profile/bsky.app/post/${RKEY}/`],
    [
      'a post URL with a query and fragment',
      `https://bsky.app/profile/bsky.app/post/${RKEY}?a=1#b`,
    ],
  ])('sends %s as the handle-authority AT-URI', async (_label, uri) => {
    http.route({ match: /app\.bsky\.feed\.getPostThread/, respond: thread });
    const result = await runToolContract(bskyGetPostThread, { uri });
    expect(result.isError).toBeFalsy();
    expect(sentParam('app.bsky.feed.getPostThread', 'uri')).toBe(
      `at://bsky.app/app.bsky.feed.post/${RKEY}`,
    );
  });

  it('post_not_found names the rewritten AT-URI', async () => {
    http.route({
      match: /app\.bsky\.feed\.getPostThread/,
      respond: () =>
        Response.json({ error: 'NotFound', message: 'Post not found' }, { status: 400 }),
    });
    const result = await runToolContract(bskyGetPostThread, {
      uri: 'https://bsky.app/profile/bsky.app/post/3zzzzzzzzzzzz?x=1',
    });
    expect(errorOf(result).data?.reason).toBe('post_not_found');
    expect(errorOf(result).message).toBe(
      'Post not found: "at://bsky.app/app.bsky.feed.post/3zzzzzzzzzzzz"',
    );
  });

  it.each([
    ['a feed URL', 'https://bsky.app/profile/bsky.app/feed/whats-hot'],
    ['a profile URL', 'https://bsky.app/profile/bsky.app'],
    ['a list page', 'https://bsky.app/profile/bsky.app/lists/3lc4'],
    ['a quotes page', `https://bsky.app/profile/bsky.app/post/${RKEY}/quotes`],
    ['@handle', '@bsky.app'],
  ])('rejects %s with the field message before any request', async (_label, uri) => {
    const result = await runToolContract(bskyGetPostThread, { uri });
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(textOf(result)).toContain('bsky.app post URL');
    expect(http.calls).toHaveLength(0);
  });
});

describe('bsky_get_post_quotes uri', () => {
  it('reads a post URL through the same parser, resolving its handle', async () => {
    http.route(
      {
        match: /com\.atproto\.identity\.resolveHandle\?handle=bsky\.app$/,
        respond: () => Response.json({ did: DID }),
      },
      {
        match: /app\.bsky\.feed\.getQuotes/,
        respond: () => Response.json({ posts: [postView('q')] }),
      },
    );
    const result = await runToolContract(bskyGetPostQuotes, {
      uri: `https://bsky.app/profile/bsky.app/post/${RKEY}/?ref=x`,
    });
    expect(result.isError).toBeFalsy();
    expect(sentParam('app.bsky.feed.getQuotes', 'uri')).toBe(
      `at://${DID}/app.bsky.feed.post/${RKEY}`,
    );
  });
});

describe('bsky_get_feed URL tail', () => {
  it.each([
    ['a trailing slash', 'https://bsky.app/profile/bsky.app/feed/whats-hot/'],
    ['a query', 'https://bsky.app/profile/bsky.app/feed/whats-hot?ref=x'],
    ['a fragment', 'https://bsky.app/profile/bsky.app/feed/whats-hot#top'],
  ])('drops %s', async (_label, feed) => {
    http.route(
      {
        match: /com\.atproto\.identity\.resolveHandle\?handle=bsky\.app$/,
        respond: () => Response.json({ did: DID }),
      },
      { match: /app\.bsky\.feed\.getFeed/, respond: () => Response.json({ feed: [] }) },
    );
    const result = await runToolContract(bskyGetFeed, { feed });
    expect(result.isError).toBeFalsy();
    expect(sentParam('app.bsky.feed.getFeed', 'feed')).toBe(
      `at://${DID}/app.bsky.feed.generator/whats-hot`,
    );
  });
});

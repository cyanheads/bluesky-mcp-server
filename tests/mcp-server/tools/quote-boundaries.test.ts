/**
 * @fileoverview Every blockquote framing Bluesky-authored text ends before the server line that
 * follows it. Whole rendered pages are parsed with the CommonMark reference implementation
 * (`commonmark`), and each outermost `block_quote` must hold exactly one user-authored value — a
 * server line such as `*3 likes*`, `🔗 Link card:`, or `**Labels:**` that CommonMark folded into the
 * quote as a lazy continuation would show up as extra text inside it. Covers post bodies, link
 * cards, image alt text, quoted posts and their own attachments nested two deep, profile bios, and
 * trend summaries; the tool-level cases drive raw AppView-shaped responses through the real service
 * over a faked `fetch`.
 * @module tests/mcp-server/tools/quote-boundaries.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import type { Node } from 'commonmark';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFollows } from '@/mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { bskyGetProfile } from '@/mcp-server/tools/definitions/bsky-get-profile.tool.js';
import { bskyGetTrending } from '@/mcp-server/tools/definitions/bsky-get-trending.tool.js';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import type { RenderablePost } from '@/mcp-server/tools/post-format.js';
import { renderEmbedLines, renderPostLines } from '@/mcp-server/tools/post-format.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

// ---------------------------------------------------------------------------
// CommonMark inspection
// ---------------------------------------------------------------------------

const parser = new Parser();
const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The text a renderer shows for a node and everything inside it. */
function shownText(node: Node): string {
  const walker = node.walker();
  let text = '';
  for (let event = walker.next(); event; event = walker.next()) {
    if (!event.entering) continue;
    const n = event.node;
    if (n.type === 'text' || n.type === 'code') text += n.literal ?? '';
    if (n.type === 'softbreak' || n.type === 'linebreak' || n.type === 'paragraph') text += ' ';
  }
  return normalize(text);
}

/** The shown text of every block quote not nested inside another, in document order. */
function outermostQuotes(markdown: string): string[] {
  const walker = parser.parse(markdown).walker();
  const quotes: string[] = [];
  let depth = 0;
  for (let event = walker.next(); event; event = walker.next()) {
    if (event.node.type !== 'block_quote') continue;
    if (event.entering) {
      if (depth === 0) quotes.push(shownText(event.node));
      depth++;
    } else {
      depth--;
    }
  }
  return quotes;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');

// ---------------------------------------------------------------------------
// The shared renderer
// ---------------------------------------------------------------------------

const BODY = 'Hello Bluesky';

const makePost = (overrides: Partial<RenderablePost> = {}): RenderablePost => ({
  uri: 'at://did:plc:a/app.bsky.feed.post/1',
  cid: 'bafyc',
  text: BODY,
  author: { did: 'did:plc:a', handle: 'a.bsky.social', displayName: 'A' },
  ...overrides,
});

describe('renderPostLines — the quote ends before the server line after it', () => {
  it('keeps the counts and timestamps out of the post body (the case in the issue)', () => {
    const md = renderPostLines(makePost({ likeCount: 3, createdAt: '2026-09-01T00:00:00Z' })).join(
      '\n',
    );
    expect(outermostQuotes(md)).toEqual([BODY]);
  });

  it('keeps every server line out of every quote on a fully loaded post', () => {
    const md = renderPostLines(
      makePost({
        likeCount: 3,
        repostCount: 1,
        replyCount: 2,
        quoteCount: 4,
        createdAt: '2026-09-01T00:00:00Z',
        indexedAt: '2026-09-01T00:00:01Z',
        replyToUri: 'at://did:plc:a/app.bsky.feed.post/0',
        replyRootUri: 'at://did:plc:a/app.bsky.feed.post/r',
        author: {
          did: 'did:plc:a',
          handle: 'a.bsky.social',
          avatar: 'https://cdn.example/a.jpg',
        },
        labels: [{ val: 'spam', src: 'did:plc:labeler' }],
        embed: {
          type: 'external',
          uri: 'https://example.com/a',
          title: 'Card title',
          description: 'Card description\nsecond line',
        },
      }),
    ).join('\n');
    expect(outermostQuotes(md)).toEqual([BODY, 'Card title', 'Card description second line']);
  });

  it('ends each image alt quote before the next image URL', () => {
    const md = renderPostLines(
      makePost({
        embed: {
          type: 'images',
          images: [
            { url: 'https://cdn.example/1.jpg', alt: 'First alt' },
            { url: 'https://cdn.example/2.jpg', alt: 'Second alt' },
          ],
        },
        labels: [{ val: 'nudity' }],
      }),
    ).join('\n');
    expect(outermostQuotes(md)).toEqual([BODY, 'First alt', 'Second alt']);
  });

  it('ends each quote of a quoted post, its own attachments, and the quoting media, two levels deep', () => {
    const md = renderPostLines(
      makePost({
        likeCount: 1,
        embed: {
          type: 'record',
          uri: 'at://did:plc:b/app.bsky.feed.post/q1',
          cid: 'bafyq1',
          authorHandle: 'b.bsky.social',
          text: 'Quoted text',
          embeds: [
            {
              type: 'record',
              uri: 'at://did:plc:c/app.bsky.feed.post/q2',
              cid: 'bafyq2',
              authorHandle: 'c.bsky.social',
              text: 'Deep quoted text',
              omittedEmbeds: 1,
            },
            { type: 'images', images: [{ url: 'https://cdn.example/q.jpg', alt: 'Quoted alt' }] },
          ],
          media: {
            type: 'external',
            uri: 'https://example.com/m',
            title: 'Media title',
            description: 'Media description',
          },
        },
        labels: [{ val: 'spam' }],
      }),
    ).join('\n');
    expect(outermostQuotes(md)).toEqual([
      BODY,
      'Quoted text',
      'Deep quoted text',
      'Quoted alt',
      'Media title',
      'Media description',
    ]);
  });

  it('ends a link card title quote before its Description label when the embed renders alone', () => {
    const md = renderEmbedLines({
      type: 'external',
      uri: 'https://example.com/a',
      title: 'T',
      description: 'D',
    }).join('\n');
    expect(outermostQuotes(md)).toEqual(['T', 'D']);
  });
});

// ---------------------------------------------------------------------------
// Through the production path
// ---------------------------------------------------------------------------

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

const BIO = 'Line one of the bio\nline two';
const SHOWN_BIO = 'Line one of the bio line two';

const rawActor = (did: string, handle: string, extra: Record<string, unknown> = {}) => ({
  did,
  handle,
  description: BIO,
  labels: [{ src: 'did:plc:labeler', uri: `at://${did}/app.bsky.actor.profile/self`, val: 'bot' }],
  avatar: `https://cdn.example/${handle}.jpg`,
  ...extra,
});

describe('bios and summaries through the tools', () => {
  it('bsky_get_profile: the bio ends before the pinned-post and label lines of a sparse profile', async () => {
    http.route({
      match: /app\.bsky\.actor\.getProfile/,
      respond: Response.json({
        did: 'did:plc:p',
        handle: 'p.bsky.social',
        description: BIO,
        pinnedPost: { uri: 'at://did:plc:p/app.bsky.feed.post/pin', cid: 'bafypin' },
        labels: [{ src: 'did:plc:labeler', val: 'bot' }],
        createdAt: '2024-01-01T00:00:00.000Z',
      }),
    });
    const result = await runToolContract(bskyGetProfile, { actor: 'p.bsky.social' });
    expect(result.isError).toBeFalsy();
    expect(outermostQuotes(textOf(result))).toEqual([SHOWN_BIO]);
  });

  it('bsky_search_actors: each bio ends before its Labels line', async () => {
    http.route({
      match: /app\.bsky\.actor\.searchActors/,
      respond: Response.json({
        actors: [rawActor('did:plc:x', 'x.bsky.social'), rawActor('did:plc:y', 'y.bsky.social')],
      }),
    });
    const result = await runToolContract(bskySearchActors, { query: 'x' });
    expect(result.isError).toBeFalsy();
    expect(outermostQuotes(textOf(result))).toEqual([SHOWN_BIO, SHOWN_BIO]);
  });

  it('bsky_get_follows: each bio ends before its Labels line', async () => {
    http.route({
      match: /app\.bsky\.graph\.getFollowers/,
      respond: Response.json({
        subject: { did: 'did:plc:s', handle: 's.bsky.social' },
        followers: [rawActor('did:plc:x', 'x.bsky.social')],
      }),
    });
    const result = await runToolContract(bskyGetFollows, {
      actor: 's.bsky.social',
      direction: 'followers',
    });
    expect(result.isError).toBeFalsy();
    expect(outermostQuotes(textOf(result))).toEqual([SHOWN_BIO]);
  });

  it("bsky_get_trending: a trend's summary ends before its Started line, inside its list item", async () => {
    http.route({
      match: /app\.bsky\.unspecced\.getTrends/,
      respond: Response.json({
        trends: [
          {
            topic: 'a1b2c3d4e5f6',
            displayName: 'Topic',
            description: 'What the story is about',
            link: '/profile/trending.bsky.app/feed/a1b2c3d4e5f6',
            startedAt: '2026-09-25T00:00:00.000Z',
            postCount: 12,
            status: 'hot',
            category: 'news',
            actors: [],
          },
        ],
      }),
    });
    const result = await runToolContract(bskyGetTrending, { limit: 1 });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(outermostQuotes(text)).toEqual(['What the story is about']);
    /** The item keeps its Started line: the blank line leaves it in the list, outside the quote. */
    const items = parser.parse(text).firstChild;
    expect(items?.type).toBe('list');
    expect(shownText(items as Node)).toContain('Started: 2026-09-25T00:00:00.000Z');
  });

  it('bsky_get_author_feed: two posts, each body and nested quote closed, on one page', async () => {
    const raw = (rkey: string) => ({
      uri: `at://did:plc:a/app.bsky.feed.post/${rkey}`,
      cid: `bafy${rkey}`,
      author: { did: 'did:plc:a', handle: 'a.bsky.social' },
      record: { text: `Body ${rkey}` },
      likeCount: 1,
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: 'at://did:plc:b/app.bsky.feed.post/q',
          cid: 'bafyq',
          author: { did: 'did:plc:b', handle: 'b.bsky.social' },
          value: { text: `Quoted by ${rkey}` },
          embeds: [
            {
              $type: 'app.bsky.embed.images#view',
              images: [{ fullsize: 'https://cdn.example/q.jpg', alt: `Alt under ${rkey}` }],
            },
          ],
        },
      },
    });
    http.route({
      match: /app\.bsky\.feed\.getAuthorFeed/,
      respond: Response.json({ feed: [{ post: raw('p1') }, { post: raw('p2') }], cursor: 'c' }),
    });
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'a.bsky.social' });
    expect(result.isError).toBeFalsy();
    expect(outermostQuotes(textOf(result))).toEqual([
      'Body p1',
      'Quoted by p1',
      'Alt under p1',
      'Body p2',
      'Quoted by p2',
      'Alt under p2',
      /** The framework's own enrichment notice — server text in a quote of its own. */
      'More posts exist — pass the returned cursor to fetch the next page.',
    ]);
  });

  it('bsky_get_post_thread: every node body closes before its counts, at every depth', async () => {
    const node = (rkey: string, replies: unknown[] = [], parent?: string) => ({
      $type: 'app.bsky.feed.defs#threadViewPost',
      post: {
        uri: `at://did:plc:a/app.bsky.feed.post/${rkey}`,
        cid: `bafy${rkey}`,
        author: { did: 'did:plc:a', handle: 'a.bsky.social' },
        record: {
          text: `Body ${rkey}`,
          ...(parent
            ? {
                reply: {
                  parent: { uri: `at://did:plc:a/app.bsky.feed.post/${parent}` },
                  root: { uri: 'at://did:plc:a/app.bsky.feed.post/root' },
                },
              }
            : {}),
        },
        likeCount: 2,
        replyCount: replies.length,
      },
      replies,
    });
    http.route({
      match: /app\.bsky\.feed\.getPostThread/,
      respond: Response.json({
        thread: node('root', [node('r1', [node('r2', [], 'r1')], 'root')]),
      }),
    });
    const result = await runToolContract(bskyGetPostThread, {
      uri: 'at://did:plc:a/app.bsky.feed.post/root',
    });
    expect(result.isError).toBeFalsy();
    expect(outermostQuotes(textOf(result))).toEqual(['Body root', 'Body r1', 'Body r2']);
  });
});

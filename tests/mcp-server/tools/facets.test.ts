/**
 * @fileoverview Rich-text metadata through the real service and tool response contracts.
 * @module tests/mcp-server/tools/facets
 */
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFeed } from '@/mcp-server/tools/definitions/bsky-get-feed.tool.js';
import { bskyGetPostQuotes } from '@/mcp-server/tools/definitions/bsky-get-post-quotes.tool.js';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { destinationLink, renderPostLines } from '@/mcp-server/tools/post-format.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import { FacetSchema } from '@/services/bluesky/post-facets.js';
import {
  postUri,
  rawPost,
  routeAuthorFeed,
  routeQuotes,
  routeRankedFeed,
  routeSearch,
  surfaces,
  textOf,
} from './budget-fixtures.js';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});
const text = '🙂 café link @alice #科学';
const facets = [
  {
    index: { byteStart: 11, byteEnd: 15 },
    features: [
      {
        $type: 'app.bsky.richtext.facet#link',
        uri: 'https://example.com/full_(destination)?a=[b]&x=1',
      },
    ],
  },
  {
    index: { byteStart: 16, byteEnd: 22 },
    features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:alice' }],
  },
  {
    index: { byteStart: 23, byteEnd: 30 },
    features: [{ $type: 'app.bsky.richtext.facet#tag', tag: '科学' }],
  },
];
const post = () => ({
  ...rawPost(postUri('facet')),
  record: { ...rawPost(postUri('facet')).record, text, facets },
});

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
});
afterEach(() => http.restore());

describe('post text characterization', () => {
  it('keeps Unicode post text byte-for-byte and frames it separately from server metadata', async () => {
    routeAuthorFeed(http, [
      { ...rawPost(postUri('plain')), record: { ...rawPost(postUri('plain')).record, text } },
    ]);
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ posts: [{ text }] });
    expect(textOf(result)).toContain(`> ${text}\n\n*`);
    expect(result.structuredContent).toMatchObject({
      posts: [expect.not.objectContaining({ facets: expect.anything() })],
    });
  });
});

describe('facet output', () => {
  it('characterizes known feature validation before accepting extension variants', () => {
    for (const facet of facets) expect(FacetSchema.parse(facet)).toEqual(facet);
    for (const feature of [
      { $type: 'app.bsky.richtext.facet#link', uri: 123 },
      { $type: 'app.bsky.richtext.facet#mention' },
      { $type: 'app.bsky.richtext.facet#tag', tag: false },
    ])
      expect(
        FacetSchema.safeParse({ index: { byteStart: 0, byteEnd: 1 }, features: [feature] }).success,
      ).toBe(false);
  });

  it('preserves open-union feature data and forward fields through both post surfaces', async () => {
    const extension = {
      index: { byteStart: 0, byteEnd: 5, encoding: 'UTF-8' },
      features: [
        {
          $type: 'example.richtext.facet#custom',
          value: 'annotation',
          nested: {
            text: '# Title\r\n\n[escape](https://evil.example)',
            values: ['', null, false, 0, { constructor: 'own-field', deeper: ['科学', 'a\\b'] }],
          },
        },
        {
          $type: 'app.bsky.richtext.facet#link',
          uri: 'https://example.com/link',
          title: 'link extension',
        },
        {
          $type: 'app.bsky.richtext.facet#mention',
          did: 'did:plc:alice',
          annotation: { text: 'mention extension' },
        },
        { $type: 'app.bsky.richtext.facet#tag', tag: '科学', values: ['tag extension'] },
      ],
      constructor: { label: 'facet extension' },
    };
    const raw = { ...post(), record: { ...post().record, facets: [extension] } };
    routeAuthorFeed(http, [raw]);
    http.route({
      match: /app\.bsky\.feed\.getPostThread\?/,
      respond: () =>
        Response.json({
          thread: { post: raw, replies: [{ post: raw, replies: [{ post: raw }] }] },
        }),
    });
    const author = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });
    const thread = await runToolContract(bskyGetPostThread, { uri: postUri('facet'), depth: 3 });
    expect(author.isError).toBeFalsy();
    expect(thread.isError).toBeFalsy();
    expect(author.structuredContent).toMatchObject({ posts: [{ facets: [extension] }] });
    expect(thread.structuredContent).toMatchObject({
      thread: {
        post: { facets: [extension] },
        replies: [{ replies: [{ post: { facets: [extension] } }] }],
      },
    });
    for (const result of [author, thread]) {
      const walker = new Parser().parse(textOf(result)).walker();
      const literals: string[] = [];
      let depth = 0;
      for (let event = walker.next(); event; event = walker.next()) {
        if (event.node.type === 'block_quote') depth += event.entering ? 1 : -1;
        if (depth && event.entering && event.node.type === 'text')
          literals.push(event.node.literal ?? '');
      }
      const shown = literals.join('');
      for (const value of [
        extension.constructor,
        { encoding: 'UTF-8' },
        extension.features[0],
        { title: 'link extension' },
        { annotation: { text: 'mention extension' } },
        { values: ['tag extension'] },
      ])
        expect(shown).toContain(JSON.stringify(value));
      expect(textOf(result)).toContain('Link:');
      expect(textOf(result)).toContain('Mention DID: did:plc:alice');
    }
  });

  it.each([
    { $type: 'app.bsky.richtext.facet#link', uri: 123 },
    { $type: 'app.bsky.richtext.facet#mention' },
    { $type: 'app.bsky.richtext.facet#tag', tag: false },
  ])('never treats a malformed known feature as an extension ($type)', async (feature) => {
    const raw = {
      ...post(),
      record: {
        ...post().record,
        facets: [{ index: { byteStart: 0, byteEnd: 1 }, features: [feature] }],
      },
    };
    routeAuthorFeed(http, [raw]);
    http.route({
      match: /app\.bsky\.feed\.getPostThread\?/,
      respond: () => Response.json({ thread: { post: raw } }),
    });
    const author = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });
    const thread = await runToolContract(bskyGetPostThread, { uri: postUri('facet') });
    expect(author.isError).toBe(true);
    expect(thread.isError).toBe(true);
  });

  it.each([
    'https://example.com/full_(destination)?a=[b]&x=1',
    'https://example.com/a<b>\\c',
    'https://example.com/a[b',
    'https://example.com/a]b',
    'https://example.com/a![x](https://evil.example)',
    'https://example.com/科学',
    'https://example.com/a\r\nb',
    '',
  ])('round-trips the complete link destination %j through CommonMark', (uri) => {
    const walker = new Parser().parse(destinationLink(uri)).walker();
    const destinations: string[] = [];
    for (let event = walker.next(); event; event = walker.next()) {
      if (event.entering && event.node.type === 'link')
        destinations.push(decodeURI(event.node.destination ?? ''));
    }
    expect(destinations).toEqual([uri]);
  });

  it('keeps facet tags quoted and server metadata outside each user blockquote', () => {
    const markdown = renderPostLines({
      uri: postUri('hostile'),
      cid: 'c',
      author: { did: 'did:plc:x', handle: 'bsky.app' },
      text: 'body',
      likeCount: 1,
      facets: [
        {
          index: { byteStart: 0, byteEnd: 4 },
          features: [
            {
              $type: 'app.bsky.richtext.facet#tag',
              tag: '# heading\n\n[escape](https://evil.test)',
            },
          ],
        },
      ],
    }).join('\n');
    const walker = new Parser().parse(markdown).walker();
    let depth = 0;
    const quoted: string[] = [];
    for (let event = walker.next(); event; event = walker.next()) {
      if (event.node.type === 'block_quote') depth += event.entering ? 1 : -1;
      if (depth && event.entering && event.node.type === 'text')
        quoted.push(event.node.literal ?? '');
      if (event.entering && event.node.type === 'link')
        throw new Error('Tag emitted an active link');
    }
    expect(quoted.join('')).toBe('body# heading[escape](https://evil.test)');
    expect(markdown).toContain('\n\n**Facets:**');
    expect(markdown).toContain('\n\n*1 likes*');
  });

  it('budgets complete facet records and resumes the cursor without losing a post', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      ...rawPost(postUri(`large${i}`), { descriptionBytes: 0 }),
      record: {
        ...rawPost(postUri(`large${i}`)).record,
        text,
        facets: [
          {
            index: { byteStart: 11, byteEnd: 15 },
            features: [
              {
                $type: 'app.bsky.richtext.facet#link',
                uri: `https://example.com/${i}/${'a'.repeat(1800)}`,
              },
              {
                $type: 'example.richtext.facet#custom',
                value: `annotation-${i}-${'b'.repeat(1800)}`,
              },
            ],
          },
        ],
      },
    }));
    routeAuthorFeed(http, items);
    const first = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', limit: 50 });
    const page = first.structuredContent as {
      posts: Array<{ uri: string; facets: unknown }>;
      cursor: string;
      budgetCapped: boolean;
    };
    expect(page.budgetCapped).toBe(true);
    expect(page.posts.length).toBeGreaterThan(0);
    expect(page.posts.length).toBeLessThan(50);
    expect(page.posts[0]?.facets).toEqual(items[0]?.record.facets);
    expect(surfaces(first).content).toBeLessThanOrEqual(48_000);
    expect(surfaces(first).structured).toBeLessThanOrEqual(48_000);
    const second = await runToolContract(bskyGetAuthorFeed, {
      actor: 'bsky.app',
      limit: 50,
      cursor: page.cursor,
    });
    expect((second.structuredContent as { posts: Array<{ uri: string }> }).posts[0]?.uri).toBe(
      items[page.posts.length]?.uri,
    );
    const past = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app', cursor: 'c100' });
    expect(past.structuredContent).toMatchObject({ posts: [] });
  });

  it.each([undefined, []])('preserves missing versus empty facets (%j)', async (value) => {
    routeAuthorFeed(http, [
      {
        ...rawPost(postUri('empty')),
        record: {
          ...rawPost(postUri('empty')).record,
          text,
          ...(value === undefined ? {} : { facets: value }),
        },
      },
    ]);
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });
    const data = result.structuredContent as { posts: Array<Record<string, unknown>> };
    if (value === undefined) expect(data.posts[0]).not.toHaveProperty('facets');
    else {
      expect(data.posts[0]?.facets).toEqual([]);
      expect(textOf(result)).toContain('**Facets:** 0');
    }
  });
  it('preserves ranges and full destinations without rewriting the text', async () => {
    routeAuthorFeed(http, [post()]);
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ posts: [{ text, facets }] });
    expect(Buffer.from(text).subarray(11, 15).toString()).toBe('link');
    expect(textOf(result)).toContain('UTF-8 bytes 11..15');
    expect(textOf(result)).toContain('did:plc:alice');
    expect(textOf(result)).toContain('科学');
  });

  it('wires facets through ranked feed, search, quotes and recursive threads', async () => {
    const extension = {
      index: { byteStart: 0, byteEnd: 0 },
      features: [{ $type: 'example.richtext.facet#custom', value: 'all-tool-extension' }],
    };
    const extendedPost = () => ({
      ...post(),
      record: { ...post().record, facets: [...facets, extension] },
    });
    routeRankedFeed(http, () => ({ posts: [extendedPost()] }));
    routeSearch(http, [extendedPost()]);
    routeQuotes(http, [extendedPost()]);
    http.route({
      match: /app\.bsky\.feed\.getPostThread\?/,
      respond: () =>
        Response.json({
          thread: {
            post: extendedPost(),
            replies: [{ post: extendedPost(), replies: [{ post: extendedPost() }] }],
          },
        }),
    });
    const results = [
      await runToolContract(bskyGetFeed, {
        feed: 'at://did:plc:test/app.bsky.feed.generator/test',
      }),
      await runToolContract(bskySearchPosts, { query: 'science' }),
      await runToolContract(bskyGetPostQuotes, { uri: postUri('target') }),
      await runToolContract(bskyGetPostThread, { uri: postUri('facet'), depth: 3 }),
    ];
    for (const result of results) {
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.structuredContent)).toContain('richtext.facet#link');
      expect(textOf(result)).toContain('UTF-8 bytes 11..15');
      expect(JSON.stringify(result.structuredContent)).toContain('all-tool-extension');
      expect(textOf(result)).toContain('all-tool-extension');
    }
    expect(JSON.stringify(results[3]?.structuredContent).split('richtext.facet#link')).toHaveLength(
      4,
    );
  });

  it.each(['record', 'recordWithMedia'])(
    'carries nested quoted facets via %s and removes restated target metadata',
    async (kind) => {
      const quoted = {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: postUri('target'),
        cid: 'quoted-cid',
        value: {
          text,
          facets: [
            ...facets,
            {
              index: { byteStart: 0, byteEnd: 0 },
              features: [{ $type: 'example.richtext.facet#custom', value: 'quoted-extension' }],
            },
          ],
        },
        embeds: [
          {
            $type: 'app.bsky.embed.record#view',
            record: { uri: postUri('inner'), value: { text, facets } },
          },
        ],
      };
      const embed =
        kind === 'record'
          ? { $type: 'app.bsky.embed.record#view', record: quoted }
          : {
              $type: 'app.bsky.embed.recordWithMedia#view',
              record: { record: quoted },
              media: {
                $type: 'app.bsky.embed.record#view',
                record: { uri: postUri('media'), value: { text, facets } },
              },
            };
      const raw = { ...post(), embed };
      http.route({
        match: /app\.bsky\.feed\.getPostThread\?/,
        respond: () => Response.json({ thread: { post: raw } }),
      });
      const thread = await runToolContract(bskyGetPostThread, { uri: postUri('facet') });
      expect(thread.structuredContent).toMatchObject({
        thread: { post: { facets, embed: { facets: quoted.value.facets, embeds: [{ facets }] } } },
      });
      expect(textOf(thread).split('UTF-8 bytes 11..15').length).toBe(kind === 'record' ? 4 : 5);
      expect(textOf(thread)).toContain('quoted-extension');
      http.route({
        match: /app\.bsky\.feed\.getQuotes\?/,
        respond: () => Response.json({ posts: [raw] }),
      });
      const quotes = await runToolContract(bskyGetPostQuotes, { uri: postUri('target') });
      expect(quotes.structuredContent).toMatchObject({
        posts: [{ facets, embed: { uri: postUri('target') } }],
      });
      const data = quotes.structuredContent as { posts: Array<{ embed: Record<string, unknown> }> };
      expect(data.posts[0]?.embed).not.toHaveProperty('facets');
      expect(data.posts[0]?.embed).not.toHaveProperty('text');
      expect(textOf(quotes)).not.toContain('quoted-extension');
      expect(textOf(quotes).split('UTF-8 bytes 11..15').length).toBe(kind === 'record' ? 2 : 3);
    },
  );
});

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

// ---------------------------------------------------------------------------

describe('BlueskyService.getTrends — representative actors', () => {
  let service: BlueskyService;

  beforeEach(() => {
    service = new BlueskyService();
    mockFetch.mockReset();
  });

  it('maps the actors the endpoint returns onto the trend', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({
        trends: [
          {
            topic: 'marvel',
            displayName: 'Marvel',
            postCount: 622,
            actors: [
              {
                did: 'did:plc:pvpmts6cjce46y76iphrlj3w',
                handle: 'amandawtwong.bsky.social',
                displayName: 'Amanda Wong',
                avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:pvpm/aaa',
                labels: [],
                createdAt: '2023-05-01T17:01:05.543Z',
              },
              { did: 'did:plc:second', handle: 'second.bsky.social' },
            ],
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const result = await service.getTrends({ limit: 1 }, ctx);

    expect(result.trends[0].actors).toHaveLength(2);
    expect(result.trends[0].actors?.[0]).toMatchObject({
      did: 'did:plc:pvpmts6cjce46y76iphrlj3w',
      handle: 'amandawtwong.bsky.social',
      displayName: 'Amanda Wong',
    });
    expect(result.trends[0].actors?.[1]?.displayName).toBeUndefined();
  });

  it('omits actors when the endpoint returns none', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({ trends: [{ topic: 'quiet', displayName: 'Quiet' }] }),
    );

    const ctx = createMockContext();
    const result = await service.getTrends({ limit: 1 }, ctx);
    expect(result.trends[0].actors).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Embed normalization — fixtures mirror app.bsky.feed.searchPosts responses.
// ---------------------------------------------------------------------------

/** Build a raw post view carrying the given embed view. */
function rawPostWithEmbed(embed: unknown): unknown {
  return {
    uri: 'at://did:plc:author/app.bsky.feed.post/rkey1',
    cid: 'bafyrpost',
    author: { did: 'did:plc:author', handle: 'author.bsky.social' },
    record: { text: 'post text', createdAt: '2026-07-31T00:00:00Z' },
    embed,
  };
}

describe('BlueskyService — embed normalization', () => {
  let service: BlueskyService;

  beforeEach(() => {
    service = new BlueskyService();
    mockFetch.mockReset();
  });

  /** Run one embed view through searchPosts and return the normalized embed. */
  async function normalize(embed: unknown) {
    mockFetch.mockImplementation(() => fakeResponse({ posts: [rawPostWithEmbed(embed)] }));
    const result = await service.searchPosts({ q: 'test' }, createMockContext());
    return result.posts[0]?.embed;
  }

  it('maps images#view, preferring fullsize and carrying alt + aspectRatio', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.images#view',
      images: [
        {
          thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:x/aaa',
          fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:x/aaa',
          alt: 'a painting',
          aspectRatio: { height: 1350, width: 1080 },
        },
      ],
    });

    expect(embed).toEqual({
      type: 'images',
      images: [
        {
          url: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:x/aaa',
          alt: 'a painting',
          aspectRatio: { width: 1080, height: 1350 },
        },
      ],
    });
  });

  it('falls back to thumb when an images#view item has no fullsize', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.images#view',
      images: [{ thumb: 'https://cdn/thumb.jpg', alt: '' }],
    });

    expect(embed).toMatchObject({
      type: 'images',
      images: [{ url: 'https://cdn/thumb.jpg', alt: '' }],
    });
  });

  it('maps gallery#view items onto the images variant', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.gallery#view',
      items: [
        {
          $type: 'app.bsky.embed.gallery#viewImage',
          thumbnail: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:y/bbb',
          fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:y/bbb',
          alt: '',
          aspectRatio: { height: 947, width: 1065 },
        },
        {
          $type: 'app.bsky.embed.gallery#viewImage',
          thumbnail: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:y/ccc',
          fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:y/ccc',
          alt: 'second',
          aspectRatio: { height: 883, width: 1199 },
        },
      ],
    });

    expect(embed).toEqual({
      type: 'images',
      images: [
        {
          url: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:y/bbb',
          alt: '',
          aspectRatio: { width: 1065, height: 947 },
        },
        {
          url: 'https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:y/ccc',
          alt: 'second',
          aspectRatio: { width: 1199, height: 883 },
        },
      ],
    });
  });

  it('falls back to thumbnail — not thumb — for a gallery item without fullsize', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.gallery#view',
      items: [{ thumbnail: 'https://cdn/gallery-thumb.jpg', alt: 'only thumbnail' }],
    });

    expect(embed).toMatchObject({
      type: 'images',
      images: [{ url: 'https://cdn/gallery-thumb.jpg', alt: 'only thumbnail' }],
    });
  });

  it('maps external#view', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.external#view',
      external: {
        uri: 'https://youtu.be/noLPhZvcBpw',
        title: 'Dokken - Dream Warriors (Official Music Video)',
        description: 'YouTube video by RHINO',
        thumb: 'https://cdn/ext-thumb.jpg',
      },
    });

    expect(embed).toEqual({
      type: 'external',
      uri: 'https://youtu.be/noLPhZvcBpw',
      title: 'Dokken - Dream Warriors (Official Music Video)',
      description: 'YouTube video by RHINO',
      thumb: 'https://cdn/ext-thumb.jpg',
    });
  });

  it('maps record#view to the quoted post, without a media field', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: 'at://did:plc:quoted/app.bsky.feed.post/q1',
        cid: 'bafyrquoted',
        author: { did: 'did:plc:quoted', handle: 'quoted.bsky.social' },
        value: { text: 'the quoted text' },
      },
    });

    expect(embed).toEqual({
      type: 'record',
      uri: 'at://did:plc:quoted/app.bsky.feed.post/q1',
      cid: 'bafyrquoted',
      text: 'the quoted text',
      authorHandle: 'quoted.bsky.social',
    });
  });

  it('unwraps recordWithMedia#view to the nested quote and recurses into its media', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: {
        $type: 'app.bsky.embed.images#view',
        images: [
          {
            thumb: 'https://cdn/rwm-thumb.jpg',
            fullsize: 'https://cdn/rwm-full.jpg',
            alt: 'attached image',
            aspectRatio: { height: 894, width: 894 },
          },
        ],
      },
      record: {
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: 'at://did:plc:a4gxuyfuddic74vbz6u7aptx/app.bsky.feed.post/3mrngrpimic2v',
          cid: 'bafyreif2cg23ue6ejuvkbyyzgabq3u4vpcp3b55urmrlnuxijajxujkw4m',
          author: { did: 'did:plc:a4gxuyfuddic74vbz6u7aptx', handle: 'thefatnerd.bsky.social' },
          value: { text: 'I settled for blaidd.' },
        },
      },
    });

    expect(embed).toEqual({
      type: 'record',
      uri: 'at://did:plc:a4gxuyfuddic74vbz6u7aptx/app.bsky.feed.post/3mrngrpimic2v',
      cid: 'bafyreif2cg23ue6ejuvkbyyzgabq3u4vpcp3b55urmrlnuxijajxujkw4m',
      text: 'I settled for blaidd.',
      authorHandle: 'thefatnerd.bsky.social',
      media: {
        type: 'images',
        images: [
          {
            url: 'https://cdn/rwm-full.jpg',
            alt: 'attached image',
            aspectRatio: { width: 894, height: 894 },
          },
        ],
      },
    });
  });

  it('carries an external media payload on recordWithMedia#view', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: {
        $type: 'app.bsky.embed.external#view',
        external: {
          uri: 'https://youtu.be/noLPhZvcBpw',
          title: 'Dream Warriors',
          description: 'YouTube video by RHINO',
        },
      },
      record: {
        record: {
          uri: 'at://did:plc:w2273pgz2a26epx7sy23yual/app.bsky.feed.post/3mrx25xifv22l',
          cid: 'bafyreidpjn3ac5gbobznbxslasbe4obbgzzwbxrn6sygqrzr4jtsgbdqgq',
        },
      },
    });

    expect(embed).toMatchObject({
      type: 'record',
      uri: 'at://did:plc:w2273pgz2a26epx7sy23yual/app.bsky.feed.post/3mrx25xifv22l',
      media: { type: 'external', uri: 'https://youtu.be/noLPhZvcBpw', title: 'Dream Warriors' },
    });
  });

  it('does not let recordWithMedia#view fall into the record#view branch', async () => {
    const embed = (await normalize({
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: { $type: 'app.bsky.embed.images#view', images: [] },
      record: { record: { uri: 'at://did:plc:q/app.bsky.feed.post/q9', cid: 'bafyrq9' } },
    })) as { uri: string; cid: string };

    expect(embed.uri).toBe('at://did:plc:q/app.bsky.feed.post/q9');
    expect(embed.cid).toBe('bafyrq9');
  });

  it('maps video#view', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.video#view',
      cid: 'bafkreifbcoifkrayxme6ct2ghtwnoq7zk3snifzrftidx72ednaago72ci',
      playlist: 'https://video.bsky.app/watch/did%3Aplc%3Alvk3/bafkrei/playlist.m3u8',
      thumbnail: 'https://video.bsky.app/watch/did%3Aplc%3Alvk3/bafkrei/thumbnail.jpg',
      aspectRatio: { height: 720, width: 720 },
      presentation: 'default',
    });

    expect(embed).toEqual({
      type: 'video',
      playlist: 'https://video.bsky.app/watch/did%3Aplc%3Alvk3/bafkrei/playlist.m3u8',
      thumbnail: 'https://video.bsky.app/watch/did%3Aplc%3Alvk3/bafkrei/thumbnail.jpg',
      presentation: 'default',
      aspectRatio: { width: 720, height: 720 },
    });
  });

  it('reports an unmapped lexicon type as unknown, carrying the raw $type', async () => {
    const embed = await normalize({ $type: 'app.bsky.embed.somethingNew#view', payload: {} });
    expect(embed).toEqual({ type: 'unknown', raw: 'app.bsky.embed.somethingNew#view' });
  });

  it('leaves recordKind off an ordinary quoted post', async () => {
    const embed = await normalize({
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: 'at://did:plc:quoted/app.bsky.feed.post/ok1',
        cid: 'bafyrok1',
        author: { did: 'did:plc:quoted', handle: 'quoted.bsky.social' },
        value: { text: 'still here' },
      },
    });

    expect(embed).not.toHaveProperty('recordKind');
  });

  /**
   * Fixtures mirror live `app.bsky.embed.record#view` payloads: the notFound, blocked,
   * generator, list, and starterPack shapes were captured from api.bsky.app; the
   * detached and labeler shapes come from the app.bsky.embed.record lexicon's union.
   */
  it.each([
    [
      'a deleted quote',
      {
        $type: 'app.bsky.embed.record#viewNotFound',
        uri: 'at://did:plc:5d6ubg6k6re3hxad7flmeu4j/app.bsky.feed.post/3mrxd4a5ng22y',
        notFound: true,
      },
      'notFound',
    ],
    [
      'a blocked quote',
      {
        $type: 'app.bsky.embed.record#viewBlocked',
        uri: 'at://did:plc:ncg5ss65jnutetxtj62jyz7d/app.bsky.feed.post/3mrwwamq34z2m',
        blocked: true,
        author: { did: 'did:plc:ncg5ss65jnutetxtj62jyz7d' },
      },
      'blocked',
    ],
    [
      'a detached quote',
      {
        $type: 'app.bsky.embed.record#viewDetached',
        uri: 'at://did:plc:x/app.bsky.feed.post/detached1',
        detached: true,
      },
      'detached',
    ],
    [
      'a quoted feed generator',
      {
        $type: 'app.bsky.feed.defs#generatorView',
        uri: 'at://did:plc:vpkhqolt662uhesyj6nxm7ys/app.bsky.feed.generator/infreq',
        cid: 'bafyreidgq7obamutn5ymk7u62nbspkn4ztbv3uujvfov7kj6nsuwxnbri4',
        displayName: 'Quiet Posters',
        creator: { did: 'did:plc:vpkhqolt662uhesyj6nxm7ys', handle: 'why.bsky.world' },
      },
      'generator',
    ],
    [
      'a quoted list',
      {
        $type: 'app.bsky.graph.defs#listView',
        uri: 'at://did:plc:nubjnimkaontsl5thydrvsiz/app.bsky.graph.list/3mrsmgzguo42o',
        cid: 'bafyreiawvvx6qbw6cxw454xt5hcdpxnddci64ucbfz4lzaars4q6npefya',
        name: 'Blue Crew!',
        creator: { did: 'did:plc:nubjnimkaontsl5thydrvsiz', handle: 'fireeyebooks.bsky.social' },
      },
      'list',
    ],
    [
      'a quoted starter pack',
      {
        $type: 'app.bsky.graph.defs#starterPackViewBasic',
        uri: 'at://did:plc:24noy5d3fheipwyw5qadkwku/app.bsky.graph.starterpack/3mrwv66oxxd2m',
        cid: 'bafyreihffclxwszgz4rvr3tpka36pdibwdlkplq3abbrjkpz2a2ydm26mm',
        record: { name: 'Pitch Event Starter Pack' },
        creator: { did: 'did:plc:24noy5d3fheipwyw5qadkwku', handle: 'slowlaurus.bsky.social' },
      },
      'starterPack',
    ],
    [
      'a quoted labeler service',
      {
        $type: 'app.bsky.labeler.defs#labelerView',
        uri: 'at://did:plc:x/app.bsky.labeler.service/self',
        cid: 'bafyrlabeler',
        creator: { did: 'did:plc:x', handle: 'labeler.bsky.social' },
      },
      'labeler',
    ],
  ])(
    'discriminates %s with recordKind, and fabricates no text or author',
    async (_label, record, expectedKind) => {
      const embed = (await normalize({ $type: 'app.bsky.embed.record#view', record })) as Record<
        string,
        unknown
      >;

      expect(embed.type).toBe('record');
      expect(embed.recordKind).toBe(expectedKind);
      expect(embed.uri).toBe((record as { uri: string }).uri);
      expect(embed).not.toHaveProperty('text');
      expect(embed).not.toHaveProperty('authorHandle');
    },
  );

  it('marks a union member added upstream after this mapping as unknown', async () => {
    const embed = (await normalize({
      $type: 'app.bsky.embed.record#view',
      record: { $type: 'app.bsky.some.futureDefs#thingView', uri: 'at://did:plc:x/some.new/1' },
    })) as { recordKind?: string };

    expect(embed.recordKind).toBe('unknown');
  });

  it('carries recordKind through the recordWithMedia quote slot', async () => {
    const embed = (await normalize({
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: { $type: 'app.bsky.embed.images#view', images: [] },
      record: {
        record: {
          $type: 'app.bsky.embed.record#viewNotFound',
          uri: 'at://did:plc:x/app.bsky.feed.post/gone',
          notFound: true,
        },
      },
    })) as { recordKind?: string; media?: unknown };

    expect(embed.recordKind).toBe('notFound');
    expect(embed.media).toEqual({ type: 'images', images: [] });
  });

  it('omits the embed entirely when the post carries none', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({
        posts: [
          {
            uri: 'at://did:plc:author/app.bsky.feed.post/plain',
            cid: 'bafyrplain',
            author: { did: 'did:plc:author', handle: 'author.bsky.social' },
            record: { text: 'no embed' },
          },
        ],
      }),
    );
    const result = await service.searchPosts({ q: 'test' }, createMockContext());
    expect(result.posts[0]?.embed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Feed items — repost markers and reply context.
// ---------------------------------------------------------------------------

/** Raw post view for a post written by someone other than the requested actor. */
const OTHER_AUTHOR_POST = {
  uri: 'at://did:plc:orta/app.bsky.feed.post/3mrx1',
  cid: 'bafyrorta',
  author: { did: 'did:plc:orta', handle: 'orta.io', displayName: 'Orta' },
  record: { text: 'a post by someone else', createdAt: '2026-07-31T10:00:00Z' },
};

/** reasonRepost as app.bsky.feed.getAuthorFeed returns it. */
const REPOST_REASON = {
  $type: 'app.bsky.feed.defs#reasonRepost',
  by: {
    did: 'did:plc:ragtjsm2j2vknwkz3zp4oxrd',
    handle: 'pfrazee.com',
    displayName: 'Paul Frazee',
    avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:ragt/aaa',
  },
  uri: 'at://did:plc:ragtjsm2j2vknwkz3zp4oxrd/app.bsky.feed.repost/3mrx7fyx2jz2k',
  cid: 'bafyreibolrsmf732hs5rjqcu652xo4ewa5kv6bhonssovjuxybl337avmm',
  indexedAt: '2026-07-31T14:52:54.764Z',
};

describe('BlueskyService.getAuthorFeed — feed item normalization', () => {
  let service: BlueskyService;

  beforeEach(() => {
    service = new BlueskyService();
    mockFetch.mockReset();
  });

  it('marks a reposted item with repostedBy and repostedAt', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({ feed: [{ post: OTHER_AUTHOR_POST, reason: REPOST_REASON }] }),
    );

    const result = await service.getAuthorFeed({ actor: 'pfrazee.com' }, createMockContext());
    const item = result.feed[0];

    expect(item?.repostedBy).toEqual({
      did: 'did:plc:ragtjsm2j2vknwkz3zp4oxrd',
      handle: 'pfrazee.com',
      displayName: 'Paul Frazee',
    });
    expect(item?.repostedAt).toBe('2026-07-31T14:52:54.764Z');
    // The post itself still belongs to whoever wrote it.
    expect(item?.author.handle).toBe('orta.io');
    expect(item?.text).toBe('a post by someone else');
  });

  it('leaves the actor own posts unmarked', async () => {
    mockFetch.mockImplementation(() => fakeResponse({ feed: [{ post: OTHER_AUTHOR_POST }] }));

    const result = await service.getAuthorFeed({ actor: 'pfrazee.com' }, createMockContext());

    expect(result.feed[0]?.repostedBy).toBeUndefined();
    expect(result.feed[0]?.repostedAt).toBeUndefined();
  });

  it('does not treat a non-repost reason as a repost', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({
        feed: [
          {
            post: OTHER_AUTHOR_POST,
            reason: { ...REPOST_REASON, $type: 'app.bsky.feed.defs#reasonPin' },
          },
        ],
      }),
    );

    const result = await service.getAuthorFeed({ actor: 'pfrazee.com' }, createMockContext());
    expect(result.feed[0]?.repostedBy).toBeUndefined();
  });

  it('surfaces both the parent and the root AT-URI of a reply', async () => {
    mockFetch.mockImplementation(() =>
      fakeResponse({
        feed: [
          {
            post: {
              ...OTHER_AUTHOR_POST,
              record: {
                text: 'a reply',
                reply: {
                  parent: { uri: 'at://did:plc:ragt/app.bsky.feed.post/3mrg574f5u22c' },
                  root: { uri: 'at://did:plc:7mnp/app.bsky.feed.post/3mrg4m5o2nk2l' },
                },
              },
            },
          },
        ],
      }),
    );

    const result = await service.getAuthorFeed({ actor: 'pfrazee.com' }, createMockContext());

    expect(result.feed[0]?.replyToUri).toBe('at://did:plc:ragt/app.bsky.feed.post/3mrg574f5u22c');
    expect(result.feed[0]?.replyRootUri).toBe('at://did:plc:7mnp/app.bsky.feed.post/3mrg4m5o2nk2l');
  });

  it('omits both reply URIs on a top-level post', async () => {
    mockFetch.mockImplementation(() => fakeResponse({ feed: [{ post: OTHER_AUTHOR_POST }] }));

    const result = await service.getAuthorFeed({ actor: 'pfrazee.com' }, createMockContext());

    expect(result.feed[0]?.replyToUri).toBeUndefined();
    expect(result.feed[0]?.replyRootUri).toBeUndefined();
  });
});

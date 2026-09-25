/**
 * @fileoverview The reference parser and the input patterns built on it. Every value the 0.4.0
 * patterns accepted must still be accepted with the same meaning — pinned by a differential against
 * frozen copies of those patterns over a seeded corpus — and the new forms (`@handle`, bsky.app
 * profile and post URLs, the tolerated URL tail) must be disjoint from everything accepted before.
 * @module tests/services/bluesky/at-syntax.test
 */

import { describe, expect, it } from 'vitest';
import {
  ACTOR_REF_REGEX,
  AT_URI_REF_REGEX,
  actorFromRef,
  atUriFromRef,
  FEED_REF_REGEX,
  POST_URI_REF_REGEX,
  parseBlueskyRef,
  parseFeedRef,
  parsePostRef,
} from '@/services/bluesky/at-syntax.js';

// ---------------------------------------------------------------------------
// The 0.4.0 patterns, frozen. Characterized against that build before the change: their sources
// were asserted equal to the exported AT_IDENTIFIER_REGEX, AT_URI_REGEX, and FEED_REF_REGEX.
// ---------------------------------------------------------------------------

const HANDLE =
  '(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const DID = 'did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]';
const NSID = '[a-zA-Z]+(?:\\.[a-zA-Z0-9-]+)+';
const RKEY = '[a-zA-Z0-9._~:-]{1,512}';

const OLD = {
  actor: new RegExp(`^(?:${HANDLE}|${DID})$`),
  atUri: new RegExp(`^at://(?:${HANDLE}|${DID})/${NSID}/${RKEY}$`),
  feed: new RegExp(
    `^(?:at://(${HANDLE}|${DID})/app\\.bsky\\.feed\\.generator/(${RKEY})|https://bsky\\.app/profile/(${HANDLE}|${DID})/feed/(${RKEY}))$`,
  ),
};

/** 0.4.0 `parseFeedRef`, verbatim over the frozen pattern. */
function oldParseFeedRef(ref: string) {
  const m = OLD.feed.exec(ref);
  const authority = m?.[1] ?? m?.[3];
  const rkey = m?.[2] ?? m?.[4];
  return authority && rkey ? { authority, rkey } : undefined;
}

/** The 0.4.0 post-only form the quotes tool now pins — a post AT-URI. */
const OLD_POST_URI = new RegExp(`^at://(?:${HANDLE}|${DID})/app\\.bsky\\.feed\\.post/${RKEY}$`);

// ---------------------------------------------------------------------------
// Seeded corpus
// ---------------------------------------------------------------------------

/** mulberry32 — a fixed seed, so a failure reproduces. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(0x5eed38);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const chars = (alphabet: string, lo: number, hi: number) =>
  Array.from({ length: int(lo, hi) }, () => pick([...alphabet])).join('');

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const label = () => {
  const n = int(1, 12);
  if (n === 1) return pick([...ALNUM]);
  return pick([...ALNUM]) + chars(`${ALNUM}-`, n - 2, n - 2) + pick([...ALNUM]);
};
const handle = () =>
  `${Array.from({ length: int(1, 3) }, label).join('.')}.${pick(['app', 'social', 'Com', 'x9', 'io'])}`;
const did = () =>
  `did:${pick(['plc', 'web', 'key'])}:${chars(`${ALNUM}._:%-`, 0, 24)}${pick([...`${ALNUM}._-`])}`;
const nsid = () =>
  pick([
    'app.bsky.feed.post',
    'app.bsky.feed.generator',
    'app.bsky.graph.list',
    'app.bsky.actor.profile',
    `${chars('abcXYZ', 1, 5)}.${chars(`${ALNUM}-`, 1, 8)}.${chars(ALNUM, 1, 6)}`,
  ]);
const rkey = () => chars(`${ALNUM}._~:-`, 1, 20);
const authority = () => (rand() < 0.5 ? handle() : did());

/** Values each 0.4.0 pattern accepts, plus near-misses built around them. */
function corpus(size: number): string[] {
  const out: string[] = [
    'bsky.app',
    'did:plc:z72i7hdynmk6r22z27h6tvur',
    'at://bsky.app/app.bsky.feed.post/3l6oveex3ii2l',
    'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot',
    'https://bsky.app/profile/bsky.app/feed/whats-hot',
  ];
  for (let i = 0; i < size; i++) {
    const a = authority();
    const base = pick([
      a,
      `at://${a}/${nsid()}/${rkey()}`,
      `at://${a}/app.bsky.feed.generator/${rkey()}`,
      `https://bsky.app/profile/${a}/feed/${rkey()}`,
      `https://bsky.app/profile/${a}/post/${rkey()}`,
      `https://bsky.app/profile/${a}`,
    ]);
    out.push(base);
    out.push(
      pick([
        `@${base}`,
        `${base}/`,
        `${base}?ref=${rkey()}`,
        `${base}#${rkey()}`,
        `${base}/quotes`,
        `${base} `,
        base.replace('https://', 'http://'),
        base.replace('bsky.app/profile', 'www.bsky.app/profile'),
        base.toUpperCase(),
      ]),
    );
  }
  return out;
}

const CORPUS = corpus(4000);

describe('the 0.4.0 differential', () => {
  it('the corpus exercises every 0.4.0 pattern on both sides', () => {
    for (const re of [OLD.actor, OLD.atUri, OLD.feed]) {
      expect(CORPUS.filter((v) => re.test(v)).length).toBeGreaterThan(200);
      expect(CORPUS.filter((v) => !re.test(v)).length).toBeGreaterThan(200);
    }
  });

  it('every actor 0.4.0 accepted is still accepted and names itself', () => {
    for (const value of CORPUS.filter((v) => OLD.actor.test(v))) {
      expect(ACTOR_REF_REGEX.test(value), value).toBe(true);
      expect(actorFromRef(value), value).toBe(value);
    }
  });

  it('every AT-URI 0.4.0 accepted is still accepted and names itself', () => {
    for (const value of CORPUS.filter((v) => OLD.atUri.test(v))) {
      expect(AT_URI_REF_REGEX.test(value), value).toBe(true);
      expect(atUriFromRef(value), value).toBe(value);
    }
  });

  it('every post AT-URI is accepted by the post-only pattern and names itself', () => {
    for (const value of CORPUS.filter((v) => OLD_POST_URI.test(v))) {
      expect(POST_URI_REF_REGEX.test(value), value).toBe(true);
      expect(atUriFromRef(value), value).toBe(value);
    }
  });

  it('every feed reference 0.4.0 accepted is still accepted and parses the same', () => {
    for (const value of CORPUS.filter((v) => OLD.feed.test(v))) {
      expect(FEED_REF_REGEX.test(value), value).toBe(true);
      expect(parseFeedRef(value), value).toEqual(oldParseFeedRef(value));
    }
  });

  it('parseFeedRef still finds no feed wherever 0.4.0 found none, outside the new URL tail', () => {
    for (const value of CORPUS.filter((v) => !OLD.feed.test(v))) {
      const parsed = parseFeedRef(value);
      if (parsed) expect(value, value).toMatch(/^https:\/\/bsky\.app\/profile\/.+\/feed\/.+[/?#]/);
    }
  });

  it('everything newly accepted is a form 0.4.0 refused outright: an @handle or a bsky.app URL', () => {
    const newly = [
      ...CORPUS.filter((v) => ACTOR_REF_REGEX.test(v) && !OLD.actor.test(v)),
      ...CORPUS.filter((v) => AT_URI_REF_REGEX.test(v) && !OLD.atUri.test(v)),
      ...CORPUS.filter((v) => FEED_REF_REGEX.test(v) && !OLD.feed.test(v)),
    ];
    expect(newly.length).toBeGreaterThan(100);
    for (const value of newly) {
      expect(value, value).toMatch(/^(@|https:\/\/bsky\.app\/profile\/)/);
      for (const re of [OLD.actor, OLD.atUri, OLD.feed]) expect(re.test(value), value).toBe(false);
    }
  });

  it('the parser agrees with each pattern on what it accepts', () => {
    for (const value of CORPUS) {
      const ref = parseBlueskyRef(value);
      if (ACTOR_REF_REGEX.test(value)) expect(ref?.kind, value).toBe('actor');
      if (AT_URI_REF_REGEX.test(value) || FEED_REF_REGEX.test(value)) {
        expect(ref?.kind, value).toBe('record');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The forms themselves
// ---------------------------------------------------------------------------

const DID_BSKY = 'did:plc:z72i7hdynmk6r22z27h6tvur';

describe('parseBlueskyRef', () => {
  it.each([
    ['bsky.app', { kind: 'actor', actor: 'bsky.app' }],
    ['@bsky.app', { kind: 'actor', actor: 'bsky.app' }],
    ['@BSKY.App', { kind: 'actor', actor: 'BSKY.App' }],
    [DID_BSKY, { kind: 'actor', actor: DID_BSKY }],
    ['https://bsky.app/profile/bsky.app', { kind: 'actor', actor: 'bsky.app' }],
    ['https://bsky.app/profile/bsky.app/', { kind: 'actor', actor: 'bsky.app' }],
    ['https://bsky.app/profile/bsky.app?utm_source=x', { kind: 'actor', actor: 'bsky.app' }],
    [`https://bsky.app/profile/${DID_BSKY}#top`, { kind: 'actor', actor: DID_BSKY }],
    [
      'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l',
      {
        kind: 'record',
        authority: 'bsky.app',
        collection: 'app.bsky.feed.post',
        rkey: '3l6oveex3ii2l',
      },
    ],
    [
      'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l/?ref=share#x',
      {
        kind: 'record',
        authority: 'bsky.app',
        collection: 'app.bsky.feed.post',
        rkey: '3l6oveex3ii2l',
      },
    ],
    [
      'https://bsky.app/profile/bsky.app/feed/whats-hot?ref=x',
      {
        kind: 'record',
        authority: 'bsky.app',
        collection: 'app.bsky.feed.generator',
        rkey: 'whats-hot',
      },
    ],
    [
      'at://bsky.app/app.bsky.graph.list/3lc4',
      { kind: 'record', authority: 'bsky.app', collection: 'app.bsky.graph.list', rkey: '3lc4' },
    ],
  ])('%s', (value, expected) => {
    expect(parseBlueskyRef(value)).toEqual(expected);
  });

  it.each([
    ['a list page', 'https://bsky.app/profile/bsky.app/lists/3lc4'],
    ['a post quotes page', 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l/quotes'],
    ['a post liked-by page', 'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l/liked-by'],
    ['a followers page', 'https://bsky.app/profile/bsky.app/followers'],
    ['a post page with no record key', 'https://bsky.app/profile/bsky.app/post'],
    ['@ before a URL', '@https://bsky.app/profile/bsky.app'],
    ['@ inside the path', 'https://bsky.app/profile/@bsky.app'],
    ['@ before a DID', `@${DID_BSKY}`],
    ['two @', '@@bsky.app'],
    ['www host', 'https://www.bsky.app/profile/bsky.app'],
    ['http scheme', 'http://bsky.app/profile/bsky.app'],
    ['uppercase host', 'https://BSKY.APP/profile/bsky.app'],
    ['another host', 'https://example.com/profile/bsky.app'],
    ['an AT-URI with a trailing slash', 'at://bsky.app/app.bsky.feed.post/3l6oveex3ii2l/'],
    ['an AT-URI with a query', 'at://bsky.app/app.bsky.feed.post/3l6oveex3ii2l?x=1'],
    ['a bare name', 'alice'],
  ])('rejects %s', (_label, value) => {
    expect(parseBlueskyRef(value)).toBeUndefined();
  });
});

describe('the rewrite helpers', () => {
  it('actorFromRef takes the handle or DID out of an actor form', () => {
    expect(actorFromRef('@alice.bsky.social')).toBe('alice.bsky.social');
    expect(actorFromRef('https://bsky.app/profile/alice.bsky.social/')).toBe('alice.bsky.social');
    expect(actorFromRef(`https://bsky.app/profile/${DID_BSKY}`)).toBe(DID_BSKY);
  });

  it('atUriFromRef rewrites a post URL to a post AT-URI and keeps its handle', () => {
    expect(atUriFromRef('https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l?x')).toBe(
      'at://bsky.app/app.bsky.feed.post/3l6oveex3ii2l',
    );
  });

  it('parsePostRef finds a post and nothing else', () => {
    expect(parsePostRef('https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l/')).toEqual({
      authority: 'bsky.app',
      rkey: '3l6oveex3ii2l',
    });
    expect(parsePostRef(`at://${DID_BSKY}/app.bsky.feed.generator/whats-hot`)).toBeUndefined();
    expect(parsePostRef('bsky.app')).toBeUndefined();
  });
});

describe('the input patterns', () => {
  it('an actor pattern takes a profile URL around a 253-character handle', () => {
    const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(long).toHaveLength(253);
    expect(ACTOR_REF_REGEX.test(`https://bsky.app/profile/${long}/`)).toBe(true);
    expect(actorFromRef(`https://bsky.app/profile/${long}`)).toBe(long);
  });

  it.each([
    ['a post URL on an actor field', ACTOR_REF_REGEX, 'https://bsky.app/profile/bsky.app/post/3l6'],
    ['a feed URL on an actor field', ACTOR_REF_REGEX, 'https://bsky.app/profile/bsky.app/feed/x'],
    ['a profile URL on uri', AT_URI_REF_REGEX, 'https://bsky.app/profile/bsky.app'],
    ['a feed URL on uri', AT_URI_REF_REGEX, 'https://bsky.app/profile/bsky.app/feed/whats-hot'],
    ['@handle on uri', AT_URI_REF_REGEX, '@bsky.app'],
    [
      'a feed AT-URI on the post-only pattern',
      POST_URI_REF_REGEX,
      `at://${DID_BSKY}/app.bsky.feed.generator/x`,
    ],
    [
      'a list AT-URI on the post-only pattern',
      POST_URI_REF_REGEX,
      `at://${DID_BSKY}/app.bsky.graph.list/x`,
    ],
    [
      'a profile AT-URI on the post-only pattern',
      POST_URI_REF_REGEX,
      `at://${DID_BSKY}/app.bsky.actor.profile/self`,
    ],
    [
      'a post URL on the feed pattern',
      FEED_REF_REGEX,
      'https://bsky.app/profile/bsky.app/post/3l6',
    ],
  ])('rejects %s', (_label, re, value) => {
    expect(re.test(value)).toBe(false);
  });
});

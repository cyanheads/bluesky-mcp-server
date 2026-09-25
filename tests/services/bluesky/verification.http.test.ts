/**
 * @fileoverview Bluesky verification state, from raw AppView-shaped responses through the real
 * service and normalizers over a faked `fetch`, to both response channels of every tool that
 * carries it. Profiles carry the full `app.bsky.actor.defs#verificationState`; actor lists and post
 * authors carry the two statuses alone; repost `by`, quoted-post authors, and trend voices carry
 * none. Fixtures are shaped after live responses for nytimes.com, bsky.app, and theathletic.com.
 * @module tests/services/bluesky/verification.http.test
 */

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
import { bskyGetTrending } from '@/mcp-server/tools/definitions/bsky-get-trending.tool.js';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { bskySearchPosts } from '@/mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

// ---------------------------------------------------------------------------
// Fixtures — app.bsky.actor.defs#verificationState as the AppView returns it
// ---------------------------------------------------------------------------

const BSKY_DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
const NYT_DID = 'did:plc:eclio37ymobqex2ncko63h4r';

const BSKY_ISSUED = {
  issuer: BSKY_DID,
  issuerDisplayName: 'Bluesky',
  issuerHandle: 'bsky.app',
  uri: `at://${BSKY_DID}/app.bsky.graph.verification/3lndptszmee2u`,
  isValid: true,
  createdAt: '2025-04-21T10:46:44.369Z',
};

/** nytimes.com — verified by Bluesky, and itself a trusted verifier. */
const NYT_STATE = {
  verifications: [BSKY_ISSUED],
  verifiedStatus: 'valid',
  trustedVerifierStatus: 'valid',
};

/** bsky.app — a trusted verifier nobody has verified. */
const BSKY_STATE = { verifications: [], verifiedStatus: 'none', trustedVerifierStatus: 'valid' };

/** theathletic.com — a trusted verifier whose own verification no longer holds. */
const ATHLETIC_STATE = {
  verifications: [
    {
      issuer: NYT_DID,
      issuerDisplayName: 'The New York Times',
      issuerHandle: 'nytimes.com',
      uri: `at://${NYT_DID}/app.bsky.graph.verification/3lnhck7o53d25`,
      isValid: false,
      createdAt: '2025-04-23T03:59:22.504Z',
    },
  ],
  verifiedStatus: 'invalid',
  trustedVerifierStatus: 'valid',
};

/** Two issuances — a stale one beside a valid one — the second without the optional issuer fields. */
const TWO_ISSUED_STATE = {
  verifications: [
    BSKY_ISSUED,
    {
      issuer: 'did:plc:wiredissuer',
      uri: 'at://did:plc:wiredissuer/app.bsky.graph.verification/3lold',
      isValid: false,
      createdAt: '2025-05-01T00:00:00.000Z',
    },
  ],
  verifiedStatus: 'valid',
  trustedVerifierStatus: 'none',
};

const STATUSES_OF = (state: { verifiedStatus: string; trustedVerifierStatus: string }) => ({
  verifiedStatus: state.verifiedStatus,
  trustedVerifierStatus: state.trustedVerifierStatus,
});

const rawActor = (did: string, handle: string, verification?: unknown) => ({
  did,
  handle,
  displayName: handle.split('.')[0],
  ...(verification ? { verification } : {}),
});

const rawPost = (rkey: string, author: unknown, extra: Record<string, unknown> = {}) => ({
  uri: `at://${NYT_DID}/app.bsky.feed.post/${rkey}`,
  cid: `bafy${rkey}`,
  author,
  record: { text: `text of ${rkey}` },
  ...extra,
});

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

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');

const lines = (result: { content: Array<{ type: string; text?: string }> }) =>
  textOf(result).split('\n');

const routeProfile = (raw: unknown) =>
  http.route({ match: /app\.bsky\.actor\.getProfile\?/, respond: Response.json(raw) });

// ---------------------------------------------------------------------------
// Characterization — what an account without verification renders, before and after
// ---------------------------------------------------------------------------

describe('an actor view with no verification key', () => {
  it('bsky_get_profile renders its identity line as before and no verification text', async () => {
    routeProfile(rawActor('did:plc:nerdy', 'nerdynanny.com'));
    const result = await runToolContract(bskyGetProfile, { actor: 'nerdynanny.com' });

    expect(result.isError).toBeFalsy();
    expect(lines(result)).toContain('**Handle:** @nerdynanny.com | **DID:** `did:plc:nerdy`');
    expect(textOf(result)).not.toMatch(/verif/i);
    expect(result.structuredContent).not.toHaveProperty('verification');
  });

  it('bsky_search_actors and bsky_get_follows keep a bare DID line', async () => {
    http.route(
      {
        match: /app\.bsky\.actor\.searchActors/,
        respond: Response.json({ actors: [rawActor('did:plc:wtf', 'nytimes.wtf')] }),
      },
      {
        match: /app\.bsky\.graph\.getFollows/,
        respond: Response.json({
          follows: [rawActor('did:plc:wtf', 'nytimes.wtf')],
          subject: rawActor('did:plc:subj', 'plain.bsky.social'),
        }),
      },
    );

    const search = await runToolContract(bskySearchActors, { query: 'nytimes' });
    expect(lines(search)).toContain('**DID:** `did:plc:wtf`');
    expect(textOf(search)).not.toMatch(/verif/i);

    const follows = await runToolContract(bskyGetFollows, {
      actor: 'plain.bsky.social',
      direction: 'following',
    });
    expect(lines(follows).filter((l) => l.startsWith('**DID:**'))).toEqual([
      '**DID:** `did:plc:subj`',
      '**DID:** `did:plc:wtf`',
    ]);
    expect(textOf(follows)).not.toMatch(/verif/i);
    expect(JSON.stringify(follows.structuredContent)).not.toContain('verification');
  });

  it('a post author keeps a bare Author DID line', async () => {
    http.route({
      match: /app\.bsky\.feed\.getAuthorFeed/,
      respond: Response.json({ feed: [{ post: rawPost('p1', rawActor(NYT_DID, 'nytimes.com')) }] }),
    });
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'nytimes.com' });

    expect(lines(result)).toContain(`**Author DID:** \`${NYT_DID}\``);
    expect(textOf(result)).not.toMatch(/verif/i);
  });
});

/** The three actor views the ruling leaves out carry no verification, whatever upstream sent. */
describe('surfaces held to their existing fields', () => {
  it('repost by and quoted-post authors carry none', async () => {
    const post = rawPost('p1', rawActor(NYT_DID, 'nytimes.com'), {
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: `at://${BSKY_DID}/app.bsky.feed.post/q1`,
          cid: 'bafyq1',
          author: rawActor(BSKY_DID, 'bsky.app', BSKY_STATE),
          value: { text: 'quoted' },
        },
      },
    });
    http.route({
      match: /app\.bsky\.feed\.getAuthorFeed/,
      respond: Response.json({
        feed: [
          {
            post,
            reason: {
              $type: 'app.bsky.feed.defs#reasonRepost',
              by: rawActor(BSKY_DID, 'bsky.app', BSKY_STATE),
              indexedAt: '2026-09-01T00:00:00Z',
            },
          },
        ],
      }),
    });

    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'bsky.app' });
    const item = (result.structuredContent as { posts: Array<Record<string, any>> }).posts[0];

    expect(item?.repostedBy).toEqual({ did: BSKY_DID, handle: 'bsky.app', displayName: 'bsky' });
    expect(item?.embed).not.toHaveProperty('verification');
    expect(JSON.stringify(item?.embed)).not.toContain('verif');
    expect(textOf(result)).not.toMatch(/verif/i);
  });

  it('trend voices keep their three fields', async () => {
    http.route({
      match: /app\.bsky\.unspecced\.getTrends/,
      respond: Response.json({
        trends: [
          {
            topic: 'abc',
            displayName: 'Abc',
            actors: [rawActor(NYT_DID, 'nytimes.com', NYT_STATE)],
          },
        ],
      }),
    });

    const result = await runToolContract(bskyGetTrending, { limit: 1 });
    const trend = (result.structuredContent as { trends: Array<Record<string, any>> }).trends[0];

    expect(Object.keys(trend?.actors[0] ?? {}).sort()).toEqual(['did', 'displayName', 'handle']);
    expect(textOf(result)).not.toMatch(/verif/i);
  });
});

// ---------------------------------------------------------------------------
// Profiles — the full state
// ---------------------------------------------------------------------------

describe('bsky_get_profile — full verification state', () => {
  it('carries both statuses and every verifications[] field in both channels (nytimes.com)', async () => {
    routeProfile({
      ...rawActor(NYT_DID, 'nytimes.com', NYT_STATE),
      displayName: 'The New York Times',
    });
    const result = await runToolContract(bskyGetProfile, { actor: 'nytimes.com' });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as Record<string, unknown>).verification).toEqual(NYT_STATE);
    expect(lines(result)).toContain(
      `**Handle:** @nytimes.com | **DID:** \`${NYT_DID}\` | **Verified:** valid | **Trusted verifier:** valid`,
    );
    expect(lines(result)).toContain(
      `- Issued by Bluesky (@bsky.app) \`${BSKY_DID}\` · isValid: true · created ${BSKY_ISSUED.createdAt} · \`${BSKY_ISSUED.uri}\``,
    );
  });

  it('renders the statuses and no entry lines for a trusted verifier nobody verified (bsky.app)', async () => {
    routeProfile(rawActor(BSKY_DID, 'bsky.app', BSKY_STATE));
    const result = await runToolContract(bskyGetProfile, { actor: 'bsky.app' });

    expect((result.structuredContent as Record<string, unknown>).verification).toEqual(BSKY_STATE);
    expect(textOf(result)).toContain('**Verified:** none | **Trusted verifier:** valid');
    expect(textOf(result)).not.toContain('Issued by');
    expect(textOf(result)).not.toContain('**Verifications:**');
  });

  it('renders invalid as invalid, never as verified (theathletic.com)', async () => {
    routeProfile(rawActor('did:plc:athletic', 'theathletic.com', ATHLETIC_STATE));
    const result = await runToolContract(bskyGetProfile, { actor: 'theathletic.com' });
    const text = textOf(result);

    expect(text).toContain('**Verified:** invalid | **Trusted verifier:** valid');
    expect(text).not.toContain('**Verified:** valid');
    expect(text).toContain('· isValid: false ·');
  });

  it('renders one line per issuance, and omits the issuer name and handle it did not send', async () => {
    routeProfile(rawActor('did:plc:wired', 'wired.com', TWO_ISSUED_STATE));
    const result = await runToolContract(bskyGetProfile, { actor: 'wired.com' });
    const verification = (result.structuredContent as { verification: typeof TWO_ISSUED_STATE })
      .verification;

    expect(verification.verifications).toHaveLength(2);
    expect(verification.verifications[1]).not.toHaveProperty('issuerHandle');
    expect(verification.verifications[1]).not.toHaveProperty('issuerDisplayName');
    const entries = lines(result).filter((l) => l.startsWith('- Issued by'));
    expect(entries).toHaveLength(2);
    expect(entries[1]).toBe(
      '- Issued by `did:plc:wiredissuer` · isValid: false · created 2025-05-01T00:00:00.000Z · `at://did:plc:wiredissuer/app.bsky.graph.verification/3lold`',
    );
  });

  it('passes an unrecognized status through output validation and renders it verbatim', async () => {
    routeProfile(
      rawActor('did:plc:new', 'new.bsky.social', {
        verifications: [],
        verifiedStatus: 'pending-review',
        trustedVerifierStatus: 'none',
      }),
    );
    const result = await runToolContract(bskyGetProfile, { actor: 'new.bsky.social' });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('**Verified:** pending-review | **Trusted verifier:** none');
  });

  it("keeps an issuer display name's line break and markup on its own line", async () => {
    routeProfile(
      rawActor('did:plc:x', 'x.bsky.social', {
        ...NYT_STATE,
        verifications: [{ ...BSKY_ISSUED, issuerDisplayName: 'Evil\n## **Issuer**' }],
      }),
    );
    const result = await runToolContract(bskyGetProfile, { actor: 'x.bsky.social' });

    expect(lines(result)).not.toContain('## **Issuer**');
    expect(textOf(result)).toContain('- Issued by Evil ## \\*\\*Issuer\\*\\* (@bsky.app)');
  });

  it('the bsky://profile/{actor} resource returns the same full state', async () => {
    routeProfile(rawActor(NYT_DID, 'nytimes.com', NYT_STATE));
    const profile = await bskyProfileResource.handler(
      { actor: 'nytimes.com' },
      createMockContext({ errors: bskyProfileResource.errors }),
    );

    expect(profile).toMatchObject({ verification: NYT_STATE });
  });
});

// ---------------------------------------------------------------------------
// Actor lists — the two statuses
// ---------------------------------------------------------------------------

describe('bsky_search_actors — statuses only', () => {
  it('tells nytimes.com from a look-alike, and carries no verifications array', async () => {
    http.route({
      match: /app\.bsky\.actor\.searchActors/,
      respond: Response.json({
        actors: [
          rawActor(NYT_DID, 'nytimes.com', NYT_STATE),
          rawActor('did:plc:wtf', 'nytimes.wtf'),
          rawActor('did:plc:athletic', 'theathletic.com', ATHLETIC_STATE),
        ],
      }),
    });
    const result = await runToolContract(bskySearchActors, { query: 'nytimes' });
    const actors = (result.structuredContent as { actors: Array<Record<string, unknown>> }).actors;

    expect(actors[0]?.verification).toEqual(STATUSES_OF(NYT_STATE));
    expect(actors[1]).not.toHaveProperty('verification');
    expect(actors[2]?.verification).toEqual(STATUSES_OF(ATHLETIC_STATE));
    expect(lines(result)).toContain(
      `**DID:** \`${NYT_DID}\` | **Verified:** valid | **Trusted verifier:** valid`,
    );
    expect(lines(result)).toContain('**DID:** `did:plc:wtf`');
    expect(lines(result)).toContain(
      '**DID:** `did:plc:athletic` | **Verified:** invalid | **Trusted verifier:** valid',
    );
    expect(textOf(result)).not.toContain('Issued by');
  });
});

describe('bsky_get_follows — statuses on the entries and on the hand-built subject', () => {
  it('carries both statuses on the subject and on each entry that has them', async () => {
    http.route({
      match: /app\.bsky\.graph\.getFollows/,
      respond: Response.json({
        follows: [
          rawActor('did:plc:athletic', 'theathletic.com', ATHLETIC_STATE),
          rawActor('did:plc:plain', 'plain.bsky.social'),
          rawActor('did:plc:wired', 'wired.com', TWO_ISSUED_STATE),
        ],
        subject: rawActor(NYT_DID, 'nytimes.com', NYT_STATE),
      }),
    });
    const result = await runToolContract(bskyGetFollows, {
      actor: 'nytimes.com',
      direction: 'following',
    });
    const sc = result.structuredContent as {
      actors: Array<Record<string, unknown>>;
      subject: Record<string, unknown>;
    };

    expect(sc.subject.verification).toEqual(STATUSES_OF(NYT_STATE));
    expect(sc.actors.map((a) => a.verification)).toEqual([
      STATUSES_OF(ATHLETIC_STATE),
      undefined,
      STATUSES_OF(TWO_ISSUED_STATE),
    ]);
    expect(lines(result).filter((l) => l.startsWith('**DID:**'))).toEqual([
      `**DID:** \`${NYT_DID}\` | **Verified:** valid | **Trusted verifier:** valid`,
      '**DID:** `did:plc:athletic` | **Verified:** invalid | **Trusted verifier:** valid',
      '**DID:** `did:plc:plain`',
      '**DID:** `did:plc:wired` | **Verified:** valid | **Trusted verifier:** none',
    ]);
    expect(JSON.stringify(sc)).not.toContain('verifications');
  });
});

// ---------------------------------------------------------------------------
// Post authors — the two statuses, on all five post tools
// ---------------------------------------------------------------------------

const NYT_AUTHOR_LINE = `**Author DID:** \`${NYT_DID}\` | **Verified:** valid | **Trusted verifier:** valid`;

const postsOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { posts: Array<{ author: Record<string, unknown> }> }).posts;

describe('post authors — statuses only', () => {
  it('bsky_get_author_feed', async () => {
    http.route({
      match: /app\.bsky\.feed\.getAuthorFeed/,
      respond: Response.json({
        feed: [
          { post: rawPost('p1', rawActor(NYT_DID, 'nytimes.com', NYT_STATE)) },
          { post: rawPost('p2', rawActor('did:plc:plain', 'plain.bsky.social')) },
        ],
      }),
    });
    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'nytimes.com' });

    expect(postsOf(result)[0]?.author.verification).toEqual(STATUSES_OF(NYT_STATE));
    expect(postsOf(result)[1]?.author).not.toHaveProperty('verification');
    expect(lines(result)).toContain(NYT_AUTHOR_LINE);
    expect(lines(result)).toContain('**Author DID:** `did:plc:plain`');
  });

  it('bsky_get_feed', async () => {
    http.route({
      match: /app\.bsky\.feed\.getFeed/,
      respond: Response.json({
        feed: [{ post: rawPost('p1', rawActor(NYT_DID, 'nytimes.com', NYT_STATE)) }],
      }),
    });
    const result = await runToolContract(bskyGetFeed, {
      feed: `at://${BSKY_DID}/app.bsky.feed.generator/whats-hot`,
    });

    expect(postsOf(result)[0]?.author.verification).toEqual(STATUSES_OF(NYT_STATE));
    expect(lines(result)).toContain(NYT_AUTHOR_LINE);
  });

  it('bsky_get_post_quotes', async () => {
    http.route({
      match: /app\.bsky\.feed\.getQuotes/,
      respond: Response.json({
        posts: [rawPost('p1', rawActor(NYT_DID, 'nytimes.com', NYT_STATE))],
      }),
    });
    const result = await runToolContract(bskyGetPostQuotes, {
      uri: `at://${BSKY_DID}/app.bsky.feed.post/target`,
    });

    expect(postsOf(result)[0]?.author.verification).toEqual(STATUSES_OF(NYT_STATE));
    expect(lines(result)).toContain(NYT_AUTHOR_LINE);
  });

  it('bsky_search_posts', async () => {
    const PDS = 'https://pds.example.test';
    initBlueskyService({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
    http.route(
      {
        method: 'POST',
        match: 'https://bsky.social/xrpc/com.atproto.server.createSession',
        respond: Response.json({
          accessJwt: 'access-1',
          refreshJwt: 'refresh-1',
          did: 'did:plc:operator',
          handle: 'operator.bsky.social',
          didDoc: {
            id: 'did:plc:operator',
            service: [
              { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS },
            ],
          },
        }),
      },
      {
        method: 'GET',
        match: /^https:\/\/pds\.example\.test\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
        respond: Response.json({
          posts: [rawPost('p1', rawActor(NYT_DID, 'nytimes.com', NYT_STATE))],
          hitsTotal: 1,
        }),
      },
    );
    const result = await runToolContract(bskySearchPosts, { query: 'news' });

    expect(result.isError).toBeFalsy();
    expect(postsOf(result)[0]?.author.verification).toEqual(STATUSES_OF(NYT_STATE));
    expect(lines(result)).toContain(NYT_AUTHOR_LINE);
  });

  it('bsky_get_post_thread, on the parent chain and on replies two levels below the target', async () => {
    const node = (rkey: string, author: unknown, extra: Record<string, unknown> = {}) => ({
      $type: 'app.bsky.feed.defs#threadViewPost',
      post: rawPost(rkey, author),
      ...extra,
    });
    const thread = node('target', rawActor('did:plc:plain', 'plain.bsky.social'), {
      parent: node('parent', rawActor(BSKY_DID, 'bsky.app', BSKY_STATE)),
      replies: [
        node('r1', rawActor('did:plc:athletic', 'theathletic.com', ATHLETIC_STATE), {
          replies: [
            node('r1a', rawActor(NYT_DID, 'nytimes.com', NYT_STATE), {
              replies: [node('r1a1', rawActor('did:plc:wired', 'wired.com', TWO_ISSUED_STATE))],
            }),
          ],
        }),
      ],
    });
    http.route({ match: /app\.bsky\.feed\.getPostThread/, respond: Response.json({ thread }) });

    const result = await runToolContract(bskyGetPostThread, {
      uri: `at://${NYT_DID}/app.bsky.feed.post/target`,
    });
    expect(result.isError).toBeFalsy();
    const root = (result.structuredContent as { thread: Record<string, any> }).thread;

    expect(root.post.author).not.toHaveProperty('verification');
    expect(root.parent.post.author.verification).toEqual(STATUSES_OF(BSKY_STATE));
    const r1 = root.replies[0];
    expect(r1.post.author.verification).toEqual(STATUSES_OF(ATHLETIC_STATE));
    expect(r1.replies[0].post.author.verification).toEqual(STATUSES_OF(NYT_STATE));
    expect(r1.replies[0].replies[0].post.author.verification).toEqual(
      STATUSES_OF(TWO_ISSUED_STATE),
    );
    expect(JSON.stringify(root)).not.toContain('verifications');

    const authorLines = lines(result).filter((l) => l.startsWith('**Author DID:**'));
    expect(authorLines).toEqual([
      `**Author DID:** \`${BSKY_DID}\` | **Verified:** none | **Trusted verifier:** valid`,
      '**Author DID:** `did:plc:plain`',
      '**Author DID:** `did:plc:athletic` | **Verified:** invalid | **Trusted verifier:** valid',
      NYT_AUTHOR_LINE,
      '**Author DID:** `did:plc:wired` | **Verified:** valid | **Trusted verifier:** none',
    ]);
  });
});

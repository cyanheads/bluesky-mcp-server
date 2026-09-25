/**
 * @fileoverview Fakes of the AppView endpoints behind the five post tools, for the response-budget
 * tests. Posts are shaped after live `app.bsky.feed.defs#postView` records — author with display
 * name, avatar, and verification, counts, timestamps, a label, and a link card whose description
 * sets the post's size. The paged fakes serve a fixed stream by index the way `getAuthorFeed` and
 * `getQuotes` serve theirs (a `limit: k` page is a prefix of the `limit: n` page, and its cursor
 * resumes at item k); the thread fake builds `getPostThread` answers for any node of a synthetic
 * tree, honoring `depth` and `parentHeight` and omitting `replies` at the deepest level returned,
 * as the AppView does.
 * @module tests/mcp-server/tools/budget-fixtures
 */

import { createHash } from 'node:crypto';
import type { createFetchMock } from '@cyanheads/mcp-ts-core/testing';

type FetchMock = ReturnType<typeof createFetchMock>;

export const AUTHOR_DID = 'did:plc:z72i7hdynmk6r22z27h6tvur';
export const PDS = 'https://pds.example.test';

/** Deterministic filler of exactly `bytes` ASCII bytes. */
export const filler = (seed: string, bytes: number) =>
  `${seed} `.repeat(Math.ceil(bytes / (seed.length + 1))).slice(0, bytes);

export interface RawPostOptions {
  /** Bytes of link-card description — the dial that sets how large the post renders. */
  descriptionBytes?: number;
  replyCount?: number;
  replyRoot?: string;
  replyTo?: string;
}

/** A live-shaped post view. */
export function rawPost(uri: string, options: RawPostOptions = {}) {
  const rkey = uri.split('/').at(-1) ?? '';
  const did = uri.split('/')[2] ?? AUTHOR_DID;
  return {
    uri,
    cid: `bafyreib${rkey.padEnd(52, 'q')}`,
    author: {
      did,
      handle: 'bsky.app',
      displayName: 'Bluesky',
      avatar: `https://cdn.bsky.app/img/avatar/plain/${did}/bafkreihhpqhbc6ubryotujmwaxxjpgo6aa@jpeg`,
      verification: { verifications: [], verifiedStatus: 'none', trustedVerifierStatus: 'valid' },
    },
    record: {
      $type: 'app.bsky.feed.post',
      text: `Post ${rkey}: what shipped this week, and what is next.`,
      createdAt: '2026-09-20T12:00:00.000Z',
      ...(options.replyTo
        ? {
            reply: {
              parent: { uri: options.replyTo, cid: 'bafyparent' },
              root: { uri: options.replyRoot ?? options.replyTo, cid: 'bafyroot' },
            },
          }
        : {}),
    },
    replyCount: options.replyCount ?? 4,
    repostCount: 12,
    likeCount: 87,
    quoteCount: 3,
    indexedAt: '2026-09-20T12:00:01.000Z',
    labels: [{ src: did, uri, val: 'news', cts: '2026-09-20T12:00:02.000Z' }],
    embed: {
      $type: 'app.bsky.embed.external#view',
      external: {
        uri: `https://example.com/articles/${rkey}`,
        title: `Article ${rkey}`,
        description: filler(`d-${rkey}`, options.descriptionBytes ?? 600),
      },
    },
  };
}

export const postUri = (rkey: string, did = AUTHOR_DID) => `at://${did}/app.bsky.feed.post/${rkey}`;

/** A fixed stream of posts, paged by index: cursor `c<i>` starts at item i. */
export function stream(count: number, descriptionBytes: number | ((i: number) => number) = 600) {
  return Array.from({ length: count }, (_, i) =>
    rawPost(postUri(`p${String(i).padStart(3, '0')}`), {
      descriptionBytes:
        typeof descriptionBytes === 'number' ? descriptionBytes : descriptionBytes(i),
    }),
  );
}

/** Serve `items` the way the chronological endpoints do: a limit-k page is a prefix, its cursor resumes at k. */
export function pageOf<T>(items: readonly T[], url: URL) {
  const start = Number((url.searchParams.get('cursor') ?? 'c0').slice(1));
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const page = items.slice(start, start + limit);
  const next = start + page.length;
  return { page, ...(next < items.length ? { cursor: `c${next}` } : {}) };
}

/** Route `getAuthorFeed` over a stream; `pin` is served first on a first page that asks for pins. */
export function routeAuthorFeed(
  http: FetchMock,
  items: ReturnType<typeof rawPost>[],
  pin?: ReturnType<typeof rawPost>,
) {
  http.route({
    method: 'GET',
    match: /app\.bsky\.feed\.getAuthorFeed\?/,
    respond: (request: Request) => {
      const url = new URL(request.url);
      const { page, cursor } = pageOf(items, url);
      const pinned =
        pin && url.searchParams.get('includePins') === 'true' && !url.searchParams.has('cursor')
          ? [{ post: pin, reason: { $type: 'app.bsky.feed.defs#reasonPin' } }]
          : [];
      return Response.json({
        feed: [...pinned, ...page.map((post) => ({ post }))],
        ...(cursor ? { cursor } : {}),
      });
    },
  });
}

/** Route `getQuotes` over a stream. */
export function routeQuotes(http: FetchMock, items: ReturnType<typeof rawPost>[]) {
  http.route({
    method: 'GET',
    match: /app\.bsky\.feed\.getQuotes\?/,
    respond: (request: Request) => {
      const url = new URL(request.url);
      const { page, cursor } = pageOf(items, url);
      return Response.json({
        uri: url.searchParams.get('uri'),
        posts: page,
        ...(cursor ? { cursor } : {}),
      });
    },
  });
}

/**
 * Route `getFeed` as a ranked feed: every request is answered by `answer`, called with the request
 * number (0-based) and its limit — a ranked generator reranks on every call, so a re-request need
 * not return the posts the first request did.
 */
export function routeRankedFeed(
  http: FetchMock,
  answer: (call: number, limit: number) => { posts: ReturnType<typeof rawPost>[]; cursor?: string },
) {
  let call = 0;
  http.route({
    method: 'GET',
    match: /app\.bsky\.feed\.getFeed\?/,
    respond: (request: Request) => {
      const limit = Number(new URL(request.url).searchParams.get('limit'));
      const { posts, cursor } = answer(call++, limit);
      return Response.json({
        feed: posts.map((post) => ({ post })),
        ...(cursor ? { cursor } : {}),
      });
    },
  });
}

/** Route one login, then `searchPosts` over a stream through the session's PDS. */
export function routeSearch(
  http: FetchMock,
  items: ReturnType<typeof rawPost>[],
  hitsTotal = 5000,
) {
  http.route(
    {
      method: 'POST',
      match: 'https://bsky.social/xrpc/com.atproto.server.createSession',
      once: true,
      respond: () =>
        Response.json({
          accessJwt: 'access',
          refreshJwt: 'refresh',
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
      method: 'GET',
      match: /^https:\/\/pds\.example\.test\/xrpc\/app\.bsky\.feed\.searchPosts\?/,
      respond: (request: Request) => {
        const { page, cursor } = pageOf(items, new URL(request.url));
        return Response.json({ posts: page, hitsTotal, ...(cursor ? { cursor } : {}) });
      },
    },
  );
}

/** The `limit` of every request `http` saw for `lexicon`, in order. */
export const limitsSent = (http: FetchMock, lexicon: string) =>
  http.calls
    .filter((c) => c.request.url.includes(lexicon))
    .map((c) => Number(new URL(c.request.url).searchParams.get('limit')));

// ---------------------------------------------------------------------------
// Thread fake
// ---------------------------------------------------------------------------

export interface TreeNode {
  children: string[];
  descriptionBytes: number;
  parent?: string;
  rkey: string;
}

/**
 * A synthetic conversation. `root` is the start; `branching[i]` is how many replies each node at
 * level i carries; `chain` puts that many ancestors above `root` in a straight line.
 */
export function buildTree(options: {
  branching: number[];
  chain?: number;
  descriptionBytes?: number | ((rkey: string, level: number) => number);
}) {
  const nodes = new Map<string, TreeNode>();
  const size = (rkey: string, level: number) =>
    typeof options.descriptionBytes === 'function'
      ? options.descriptionBytes(rkey, level)
      : (options.descriptionBytes ?? 600);
  let above: string | undefined;
  for (let i = options.chain ?? 0; i > 0; i--) {
    const rkey = `a${String(i).padStart(3, '0')}`;
    nodes.set(rkey, {
      rkey,
      children: [],
      descriptionBytes: size(rkey, -i),
      ...(above ? { parent: above } : {}),
    });
    if (above) nodes.get(above)?.children.push(rkey);
    above = rkey;
  }
  nodes.set('root', {
    rkey: 'root',
    children: [],
    descriptionBytes: size('root', 0),
    ...(above ? { parent: above } : {}),
  });
  if (above) nodes.get(above)?.children.push('root');
  let level = ['root'];
  options.branching.forEach((width, depth) => {
    const next: string[] = [];
    for (const parent of level) {
      for (let c = 0; c < width; c++) {
        const rkey = `${parent === 'root' ? 'r' : parent}-${c}`;
        nodes.set(rkey, { rkey, children: [], descriptionBytes: size(rkey, depth + 1), parent });
        nodes.get(parent)?.children.push(rkey);
        next.push(rkey);
      }
    }
    level = next;
  });
  return nodes;
}

const topOf = (nodes: Map<string, TreeNode>) =>
  [...nodes.values()].find((n) => !n.parent)?.rkey ?? 'root';

function threadPostOf(nodes: Map<string, TreeNode>, rkey: string) {
  const node = nodes.get(rkey);
  if (!node) throw new Error(`no node ${rkey}`);
  return rawPost(postUri(rkey), {
    descriptionBytes: node.descriptionBytes,
    replyCount: node.children.length,
    ...(node.parent ? { replyTo: postUri(node.parent), replyRoot: postUri(topOf(nodes)) } : {}),
  });
}

/** The `getPostThread` answer for `rkey`, as the AppView shapes it. */
export function threadView(
  nodes: Map<string, TreeNode>,
  rkey: string,
  depth: number,
  parentHeight: number,
) {
  const down = (key: string, remaining: number): Record<string, unknown> => ({
    $type: 'app.bsky.feed.defs#threadViewPost',
    post: threadPostOf(nodes, key),
    ...(remaining > 0
      ? { replies: (nodes.get(key)?.children ?? []).map((c) => down(c, remaining - 1)) }
      : {}),
  });
  const up = (key: string | undefined, remaining: number): Record<string, unknown> | undefined => {
    if (!key || remaining <= 0) return;
    const parent = up(nodes.get(key)?.parent, remaining - 1);
    return {
      $type: 'app.bsky.feed.defs#threadViewPost',
      post: threadPostOf(nodes, key),
      ...(parent ? { parent } : {}),
    };
  };
  const target = down(rkey, depth);
  const parent = up(nodes.get(rkey)?.parent, parentHeight);
  return { thread: { ...target, ...(parent ? { parent } : {}) } };
}

/** Route `getPostThread` over a synthetic tree. */
export function routeThread(http: FetchMock, nodes: Map<string, TreeNode>) {
  http.route({
    method: 'GET',
    match: /app\.bsky\.feed\.getPostThread\?/,
    respond: (request: Request) => {
      const url = new URL(request.url);
      const rkey = (url.searchParams.get('uri') ?? '').split('/').at(-1) ?? '';
      if (!nodes.has(rkey))
        return Response.json({ error: 'NotFound', message: 'Post not found' }, { status: 400 });
      return Response.json(
        threadView(
          nodes,
          rkey,
          Number(url.searchParams.get('depth')),
          Number(url.searchParams.get('parentHeight')),
        ),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Measuring a result the way a client receives it
// ---------------------------------------------------------------------------

type ToolResult = { structuredContent?: unknown; content: Array<{ type: string; text?: string }> };

export const textOf = (result: ToolResult) => result.content.map((b) => b.text ?? '').join('\n');

/** UTF-8 bytes of each surface: `structuredContent` serialized, and `content[]` joined. */
export const surfaces = (result: ToolResult) => ({
  structured: Buffer.byteLength(JSON.stringify(result.structuredContent), 'utf8'),
  content: Buffer.byteLength(textOf(result), 'utf8'),
});

/** SHA-256 over both surfaces — a byte-for-byte fingerprint of the response. */
export const fingerprint = (result: ToolResult) =>
  createHash('sha256')
    .update(JSON.stringify(result.structuredContent))
    .update('\u0000')
    .update(textOf(result))
    .digest('hex');

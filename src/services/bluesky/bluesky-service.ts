/**
 * @fileoverview BlueskyService — AT Protocol read client. Every read except post search goes to the
 * public AppView at https://api.bsky.app without credentials. Post search, which Bluesky's edge
 * refuses without them, runs on the app-password session in `search-session.ts`. Retry, the error
 * mapping onto each tool's declared reasons, and response normalization live here.
 * @module services/bluesky/bluesky-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  forbidden,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { defaultIsTransient, fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { FEED_REF_MESSAGE, feedGeneratorUri, parseFeedRef } from './at-syntax.js';
import { type SearchCredentials, SearchSession } from './search-session.js';
import type {
  ActorProfile,
  AuthorFeedResult,
  Embed,
  FeedResult,
  GraphResult,
  Label,
  PostAuthor,
  PostThreadResult,
  PostView,
  QuotedRecordKind,
  SearchActorsResult,
  SearchPostsResult,
  ThreadGate,
  ThreadGateRule,
  ThreadPost,
  TrendsResult,
} from './types.js';
import {
  HTML_DOCUMENT,
  httpStatus,
  TIMEOUT_MS,
  USER_AGENT,
  withoutHtmlBody,
  type XrpcParams,
  xrpcError,
  xrpcUrl,
} from './xrpc.js';

/** @internal Public Bluesky AppView — every read except post search goes here, unauthenticated. */
const APPVIEW_URL = 'https://api.bsky.app';

// ---------------------------------------------------------------------------
// Raw upstream response shapes
// ---------------------------------------------------------------------------

/** @internal Raw label object from the AppView. */
interface RawLabel {
  cts?: string;
  src?: string;
  val: string;
}

/** @internal Raw actor view returned by several AppView endpoints. */
interface RawActorView {
  avatar?: string;
  banner?: string;
  createdAt?: string;
  description?: string;
  did: string;
  displayName?: string;
  followersCount?: number;
  followsCount?: number;
  handle: string;
  indexedAt?: string;
  labels?: RawLabel[];
  pinnedPost?: { uri?: string };
  postsCount?: number;
  pronouns?: string;
  website?: string;
}

/** @internal Raw post record (lexicon fields). */
interface RawPostRecord {
  createdAt?: string;
  reply?: { parent?: { uri?: string }; root?: { uri?: string } };
  text: string;
}

/**
 * @internal Raw image view. `app.bsky.embed.images#view` names the small variant `thumb`;
 * `app.bsky.embed.gallery#viewImage` names it `thumbnail`. Both stand in for `fullsize` when it is
 * absent; neither is carried alongside it.
 */
interface RawImageView {
  alt?: string;
  fullsize?: string;
  thumb?: string;
  thumbnail?: string;
}

/**
 * @internal Raw quoted record — the `record` slot of `app.bsky.embed.record#view`. `$type` names
 * which union member arrived; only `#viewRecord` carries `author`, `value`, and `embeds`.
 */
interface RawViewRecord {
  $type?: string;
  author?: RawActorView;
  cid?: string;
  /** The quoted post's own embeds — the same `$type`-tagged views as a post's top-level `embed`. */
  embeds?: RawEmbed[];
  uri?: string;
  value?: { text?: string };
}

/** @internal Raw embed from AppView — $type discriminated. */
interface RawEmbed {
  $type?: string;
  cid?: string;
  external?: { uri?: string; title?: string; description?: string };
  images?: RawImageView[];
  /** Gallery embed images (app.bsky.embed.gallery#view). */
  items?: RawImageView[];
  /** Media attached alongside the quote (app.bsky.embed.recordWithMedia#view) — itself a $type-tagged view. */
  media?: RawEmbed;
  /** Video embed fields (app.bsky.embed.video#view). */
  playlist?: string;
  presentation?: string;
  /**
   * record#view carries the quoted post directly; recordWithMedia#view nests an
   * embed.record#view here, so the quoted post sits one level deeper at `record.record`.
   */
  record?: RawViewRecord & { record?: RawViewRecord };
  thumbnail?: string;
}

/** @internal Raw post view returned by feed, search, and thread endpoints. */
interface RawPostView {
  author: RawActorView;
  bookmarkCount?: number;
  cid: string;
  embed?: RawEmbed;
  indexedAt?: string;
  labels?: Array<{ val?: string; src?: string; cts?: string }>;
  likeCount?: number;
  quoteCount?: number;
  record: RawPostRecord;
  replyCount?: number;
  repostCount?: number;
  uri: string;
}

/**
 * @internal Raw thread node. The `thread`, `parent`, and `replies` slots are all the same
 * three-member union: `#threadViewPost` (carries `post`), `#notFoundPost` (`uri` only), and
 * `#blockedPost` (`uri` plus the blocked author's DID). There is no "more replies" member.
 */
interface RawThreadNode {
  $type?: string;
  author?: { did?: string };
  parent?: RawThreadNode;
  post?: RawPostView;
  replies?: RawThreadNode[];
  uri?: string;
}

/**
 * @internal Raw `app.bsky.feed.defs#threadgateView`, returned beside `thread` when the author
 * restricted or curated replies. `record.allow` is a union of rule objects distinguished only by
 * `$type`; an absent `allow` means anyone may reply, an empty one means nobody may.
 */
interface RawThreadGate {
  record?: {
    allow?: Array<{ $type?: string }>;
    hiddenReplies?: string[];
  };
  uri?: string;
}

/**
 * @internal Why an item sits in a feed: `app.bsky.feed.defs#reasonRepost` (carries `by`) or
 * `#reasonPin`, which arrives as a bare `$type` with nothing else on it.
 */
interface RawFeedReason {
  $type?: string;
  by?: RawActorView;
  indexedAt?: string;
}

/**
 * @internal Raw feed item — a post plus why it appears in this feed.
 * `reply` carries full parent/root post views; the same AT-URIs already reach
 * `PostView.replyToUri` / `replyRootUri` via the post record, so it is not mapped.
 */
interface RawFeedItem {
  post: RawPostView;
  reason?: RawFeedReason;
  reply?: { parent?: RawPostView; root?: RawPostView };
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeLabel(r: RawLabel): Label {
  return { val: r.val, ...(r.src ? { src: r.src } : {}), ...(r.cts ? { cts: r.cts } : {}) };
}

function normalizeActor(r: RawActorView): ActorProfile {
  return {
    did: r.did,
    handle: r.handle,
    ...(r.displayName ? { displayName: r.displayName } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.avatar ? { avatar: r.avatar } : {}),
    ...(typeof r.followersCount === 'number' ? { followersCount: r.followersCount } : {}),
    ...(typeof r.followsCount === 'number' ? { followsCount: r.followsCount } : {}),
    ...(typeof r.postsCount === 'number' ? { postsCount: r.postsCount } : {}),
    ...(r.labels?.length ? { labels: r.labels.map(normalizeLabel) } : {}),
    ...(r.indexedAt ? { indexedAt: r.indexedAt } : {}),
    ...(r.createdAt ? { createdAt: r.createdAt } : {}),
    ...(r.pinnedPost?.uri ? { pinnedPostUri: r.pinnedPost.uri } : {}),
    ...(r.pronouns ? { pronouns: r.pronouns } : {}),
    ...(r.website ? { website: r.website } : {}),
  };
}

/**
 * @internal Who wrote a post. The AppView attaches a `profileViewBasic` to every post view, which
 * also carries the account's own `createdAt`, its account-level moderation labels, and its pronouns
 * — account facts rather than post facts, declared by no post schema and rendered by no formatter.
 * Kept, they would reach a `structuredContent` reader alone. `bsky_get_profile` serves the rest.
 */
function normalizePostAuthor(r: RawActorView): PostAuthor {
  return {
    did: r.did,
    handle: r.handle,
    ...(r.displayName ? { displayName: r.displayName } : {}),
    ...(r.avatar ? { avatar: r.avatar } : {}),
  };
}

/** @internal NSID prefix every Bluesky embed view shares. */
const EMBED_NSID_PREFIX = 'app.bsky.embed.';

/**
 * @internal Embed family from a `$type`, e.g. `app.bsky.embed.gallery#view` → `gallery`.
 * Matching the NSID exactly keeps `recordWithMedia` from being swallowed by the `record` branch.
 */
function embedKind(type: string): string {
  const nsid = type.split('#')[0] ?? '';
  return nsid.startsWith(EMBED_NSID_PREFIX) ? nsid.slice(EMBED_NSID_PREFIX.length) : '';
}

/** @internal Map either an `images#view` or a `gallery#view` image list onto the `images` variant. */
function normalizeImages(items: RawImageView[] | undefined): Embed {
  return {
    type: 'images',
    images: (items ?? []).map((img) => ({
      url: img.fullsize ?? img.thumb ?? img.thumbnail ?? '',
      alt: img.alt ?? '',
    })),
  };
}

/** @internal The one `app.bsky.embed.record#view` union member that is an ordinary quoted post. */
const VIEW_RECORD_TYPE = 'app.bsky.embed.record#viewRecord';

/** @internal Every other member of that union, keyed by `$type`. */
const QUOTED_RECORD_KINDS: Record<string, QuotedRecordKind> = {
  'app.bsky.embed.record#viewNotFound': 'notFound',
  'app.bsky.embed.record#viewBlocked': 'blocked',
  'app.bsky.embed.record#viewDetached': 'detached',
  'app.bsky.feed.defs#generatorView': 'generator',
  'app.bsky.graph.defs#listView': 'list',
  'app.bsky.graph.defs#starterPackViewBasic': 'starterPack',
  'app.bsky.labeler.defs#labelerView': 'labeler',
};

/**
 * @internal Classify what arrived in the quote slot. Undefined means an ordinary quoted post,
 * so the discriminant stays off the normalized embed for the common case.
 */
function quotedRecordKind(type: string | undefined): QuotedRecordKind | undefined {
  if (!type || type === VIEW_RECORD_TYPE) return;
  return QUOTED_RECORD_KINDS[type] ?? 'unknown';
}

/**
 * @internal How many levels of quote nesting are mapped, counting the post's own embed as level 0.
 *
 * The lexicon bounds nothing: `app.bsky.embed.record#viewRecord.embeds` is a union that includes
 * `record#view` and `recordWithMedia#view`, so a quoted post may declare a quoted post forever. The
 * AppView hydrates far less. Across 797 live posts carrying 61 quotes, an `embeds` key appeared
 * only on the record quoted directly by the post — never on a record nested below that. Two levels
 * therefore cover everything it sends (a quoted post's `embeds` may itself hold a
 * `recordWithMedia#view`, whose attached media sits at level 2); the third is headroom against the
 * AppView hydrating deeper later.
 *
 * Nothing past it is followed — but nothing past it vanishes either. The quote at the bound counts
 * what it did not map into `omittedEmbeds`, so an agent reading a quote sees the difference between
 * one that carried no attachments and one whose attachments this response does not include.
 */
const MAX_EMBED_DEPTH = 3;

/**
 * @internal Map a quoted post onto the `record` variant, carrying its own embeds and any media
 * attached alongside the quote. A deleted, blocked, detached, or non-post record carries
 * `recordKind` instead of text and author — those variants have no such fields, and without the
 * discriminant they read as an empty quote.
 *
 * This is the only place the nesting depth advances, so it is where the bound is applied and where
 * the count of what the bound cost is recorded.
 */
function normalizeQuote(
  rec: RawViewRecord | undefined,
  rawMedia: RawEmbed | undefined,
  depth: number,
): Embed {
  const kind = quotedRecordKind(rec?.$type);
  const attachments = rec?.embeds ?? [];
  const bounded = depth >= MAX_EMBED_DEPTH;
  const embeds = bounded
    ? []
    : attachments
        .map((e) => normalizeEmbed(e, depth + 1))
        .filter((e): e is Embed => e !== undefined);
  const media = bounded ? undefined : normalizeEmbed(rawMedia, depth + 1);
  const omitted = attachments.length - embeds.length + (rawMedia && !media ? 1 : 0);
  return {
    type: 'record',
    uri: rec?.uri ?? '',
    cid: rec?.cid ?? '',
    ...(kind ? { recordKind: kind } : {}),
    ...(rec?.value?.text ? { text: rec.value.text } : {}),
    ...(rec?.author?.handle ? { authorHandle: rec.author.handle } : {}),
    ...(embeds.length ? { embeds } : {}),
    ...(media ? { media } : {}),
    ...(omitted > 0 ? { omittedEmbeds: omitted } : {}),
  };
}

function normalizeEmbed(r: RawEmbed | undefined, depth = 0): Embed | undefined {
  if (!r) return;
  const type = r.$type ?? '';
  switch (embedKind(type)) {
    case 'images':
      return normalizeImages(r.images);
    case 'gallery':
      return normalizeImages(r.items);
    case 'external': {
      const ext = r.external ?? {};
      return {
        type: 'external',
        uri: ext.uri ?? '',
        title: ext.title ?? '',
        description: ext.description ?? '',
      };
    }
    case 'record':
      return normalizeQuote(r.record, undefined, depth);
    case 'recordWithMedia':
      return normalizeQuote(r.record?.record, r.media, depth);
    case 'video':
      return {
        type: 'video',
        ...(r.playlist ? { playlist: r.playlist } : {}),
        ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
        ...(r.presentation ? { presentation: r.presentation } : {}),
      };
    default:
      return { type: 'unknown', raw: type };
  }
}

function normalizePost(r: RawPostView): PostView {
  const embed = normalizeEmbed(r.embed);
  return {
    uri: r.uri,
    cid: r.cid,
    text: r.record.text,
    author: normalizePostAuthor(r.author),
    ...(typeof r.replyCount === 'number' ? { replyCount: r.replyCount } : {}),
    ...(typeof r.repostCount === 'number' ? { repostCount: r.repostCount } : {}),
    ...(typeof r.likeCount === 'number' ? { likeCount: r.likeCount } : {}),
    ...(typeof r.quoteCount === 'number' ? { quoteCount: r.quoteCount } : {}),
    ...(r.indexedAt ? { indexedAt: r.indexedAt } : {}),
    ...(r.record.createdAt ? { createdAt: r.record.createdAt } : {}),
    ...(r.labels?.length
      ? {
          labels: r.labels.map((l) => ({
            val: l.val ?? '',
            ...(l.src ? { src: l.src } : {}),
            ...(l.cts ? { cts: l.cts } : {}),
          })),
        }
      : {}),
    ...(embed ? { embed } : {}),
    ...(r.record.reply?.parent?.uri ? { replyToUri: r.record.reply.parent.uri } : {}),
    ...(r.record.reply?.root?.uri ? { replyRootUri: r.record.reply.root.uri } : {}),
  };
}

/**
 * @internal Normalize a feed item, carrying its reason through: a pin as `pinned`, a repost as
 * `repostedBy` / `repostedAt`. Feed generators pin a post to the top of the feed, and without the
 * marker it reads as the newest item.
 */
function normalizeFeedItem(item: RawFeedItem): PostView {
  const post = normalizePost(item.post);
  const type = item.reason?.$type ?? '';
  if (type.endsWith('#reasonPin')) return { ...post, pinned: true };
  const by = item.reason?.by;
  if (!by || !type.endsWith('#reasonRepost')) return post;
  return {
    ...post,
    repostedBy: {
      did: by.did,
      handle: by.handle,
      ...(by.displayName ? { displayName: by.displayName } : {}),
    },
    ...(item.reason?.indexedAt ? { repostedAt: item.reason.indexedAt } : {}),
  };
}

/** @internal `$type` of the thread-union member for a post that is deleted or never existed. */
const NOT_FOUND_POST_TYPE = 'app.bsky.feed.defs#notFoundPost';

/** @internal `$type` of the thread-union member for a post whose author blocks the viewer. */
const BLOCKED_POST_TYPE = 'app.bsky.feed.defs#blockedPost';

/**
 * @internal Stand-in PostView for a thread node that carries no post. Both stub members of the
 * union report the AT-URI, so it is preserved rather than blanked; a blocked node also names
 * its author's DID.
 */
function stubPost(uri: string | undefined, authorDid?: string): PostView {
  return { uri: uri ?? '', cid: '', text: '', author: { did: authorDid ?? '', handle: '' } };
}

/**
 * @internal Where a node sits in the response, which decides which of the two shortfalls apply to
 * it. `target` is the requested post, `parent` an ancestor above it, `reply` a descendant below.
 */
type ThreadNodePosition = 'target' | 'parent' | 'reply';

/**
 * @internal Normalize one thread node.
 *
 * The reply shortfall is derived, not reported: the AppView emits no "more replies" marker, so a
 * node's own `replyCount` is compared against the replies it actually returned. The `replies` key
 * tells the two cases apart — the AppView omits it entirely at the deepest level it will return
 * (`depth`), and emits it (possibly short, possibly empty) at every level above.
 *
 * A shortfall under a present `replies` key is reported as `unavailable` rather than blamed on the
 * per-post limit, because `replyCount` is a broader number than "replies that exist and were held
 * back". Measured against the live AppView over 748 threads and 94,366 nodes, 1,930 nodes reported
 * a shortfall while carrying a `replyCount` of 3 or less, and 1,244 reported `replyCount: 1` with
 * an empty `replies` array — far below the ~150–200 replies the per-post limit actually returns.
 * Re-rooting those nodes reproduces the same empty array, and `app.bsky.unspecced.getPostThreadV2`
 * answers `hasOtherReplies: false` for them: nothing is being held back, the counter simply still
 * includes replies that have left the index.
 *
 * A `parent` position suppresses that comparison while walking upward: every parent has replies the
 * request never asked for, so flagging them would report a shortfall on every parent of every
 * thread. Parent nodes carry no `replies` key of their own, so nothing below them is skipped.
 *
 * The parent chain has its own shortfall, and the AppView gives no marker for that one either: it
 * stops the chain at the requested `parentHeight` and the topmost node it returns looks exactly
 * like a conversation root. A node on the parent spine that carries a `replyToUri` and no `parent`
 * of its own is therefore a cut, not a root. The test is confined to the spine — every reply-tree
 * node also has a `replyToUri` and no `parent`, and none of them is a cut.
 */
function normalizeThread(node: RawThreadNode, position: ThreadNodePosition = 'target'): ThreadPost {
  const typeStr = node.$type ?? '';
  if (typeStr === BLOCKED_POST_TYPE) {
    return { post: stubPost(node.uri, node.author?.did), blocked: true };
  }
  if (typeStr === NOT_FOUND_POST_TYPE || !node.post) {
    return { post: stubPost(node.uri), notFound: true };
  }

  const result: ThreadPost = { post: normalizePost(node.post) };
  if (node.parent) result.parent = normalizeThread(node.parent, 'parent');
  // Wrapped rather than passed by reference: `map` would hand the index to `position`.
  if (node.replies?.length) result.replies = node.replies.map((r) => normalizeThread(r, 'reply'));

  if (position !== 'parent') {
    const unreturned = (node.post.replyCount ?? 0) - (node.replies?.length ?? 0);
    if (unreturned > 0) {
      result.truncated = true;
      result.truncationReason = node.replies ? 'unavailable' : 'depth';
      result.unreturnedReplies = unreturned;
    }
  }
  if (position !== 'reply' && !result.parent && result.post.replyToUri) {
    result.parentChainTruncated = true;
  }
  return result;
}

/** @internal `app.bsky.feed.threadgate` rule `$type`s, mapped onto the normalized rule names. */
const THREAD_GATE_RULES: Record<string, ThreadGateRule> = {
  'app.bsky.feed.threadgate#followerRule': 'follower',
  'app.bsky.feed.threadgate#followingRule': 'following',
  'app.bsky.feed.threadgate#listRule': 'list',
  'app.bsky.feed.threadgate#mentionRule': 'mentioned',
};

/**
 * @internal Normalize the threadgate view. `allow` is carried through as present-vs-absent, since
 * an absent list ("anyone may reply") and an empty one ("nobody may reply") are different facts.
 */
function normalizeThreadGate(raw: RawThreadGate | undefined): ThreadGate | undefined {
  if (!raw?.uri) return;
  const allow = raw.record?.allow;
  return {
    uri: raw.uri,
    hiddenReplies: raw.record?.hiddenReplies ?? [],
    ...(allow ? { allow: allow.map((r) => THREAD_GATE_RULES[r.$type ?? ''] ?? 'unknown') } : {}),
  };
}

// ---------------------------------------------------------------------------
// Retry and error mapping
// ---------------------------------------------------------------------------

/**
 * @internal A failure already mapped onto one of a tool's declared reasons is an answer, not a
 * transient fault, so the retry loop hands it straight back. Without this a feed generator that is
 * down — which the AppView reports as a 502 after waiting on it for seconds — would be asked four
 * times before the caller heard anything.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof McpError && typeof (err.data as { reason?: unknown })?.reason === 'string') {
    return false;
  }
  return defaultIsTransient(err);
}

/** @internal Maps a failed request onto a tool's declared reason, or leaves it as classified. */
type ErrorMapper = (err: McpError) => McpError | undefined;

// ---------------------------------------------------------------------------
// BlueskyService class
// ---------------------------------------------------------------------------

/**
 * AT Protocol read client. Every method reads the public AppView without credentials except
 * {@link BlueskyService.searchPosts}, which runs as the configured app-password account.
 *
 * The session is shared by every caller of the process, which is why nothing it hydrates for that
 * account — the `viewer` blocks on posts and authors — is mapped into any result.
 */
export class BlueskyService {
  /** The post-search session; absent when no app password is configured. */
  private readonly search: SearchSession | undefined;

  constructor(credentials?: SearchCredentials) {
    this.search = credentials ? new SearchSession(credentials) : undefined;
  }

  /**
   * @internal Fetch JSON with retry and timeout. Failed requests lose any HTML body, then pass
   * through `mapError`; a mapped failure is final (see {@link isTransient}).
   */
  private fetchJson<T>(
    url: string,
    operation: string,
    ctx: Context,
    options: { headers?: Record<string, string>; mapError?: ErrorMapper | undefined } = {},
  ): Promise<T> {
    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers },
            signal: ctx.signal,
          });
        } catch (err) {
          if (!(err instanceof McpError)) throw err;
          const scrubbed = withoutHtmlBody(err);
          throw options.mapError?.(scrubbed) ?? scrubbed;
        }
        const text = await response.text();
        if (HTML_DOCUMENT.test(text)) {
          throw serviceUnavailable(
            'Bluesky API returned HTML — likely rate-limited or temporarily unavailable.',
          );
        }
        try {
          return JSON.parse(text) as T;
        } catch {
          throw serviceUnavailable('Bluesky API returned unparseable response.');
        }
      },
      { operation, context: ctx, baseDelayMs: 500, signal: ctx.signal, isTransient },
    );
  }

  /** @internal Unauthenticated GET against the public AppView. */
  private get<T>(
    lexicon: string,
    params: XrpcParams,
    ctx: Context,
    mapError?: ErrorMapper,
  ): Promise<T> {
    return this.fetchJson<T>(
      xrpcUrl(APPVIEW_URL, lexicon, params),
      `BlueskyService.${lexicon}`,
      ctx,
      {
        mapError,
      },
    );
  }

  /** @internal GET through the search session's PDS, which proxies it to the AppView. */
  private authedGet<T>(
    lexicon: string,
    params: XrpcParams,
    ctx: Context,
    mapError: ErrorMapper,
  ): Promise<T> {
    if (!this.search) {
      throw configurationError('Post search needs BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD.');
    }
    return this.search.run(ctx, (route) =>
      this.fetchJson<T>(
        xrpcUrl(route.serviceUrl, lexicon, params),
        `BlueskyService.${lexicon}`,
        ctx,
        { headers: route.headers, mapError },
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Public API methods
  // ---------------------------------------------------------------------------

  /**
   * Full-text post search, as the configured app-password account. The AppView drops posts from
   * accounts in a block relationship with that account; it applies no mutes.
   */
  async searchPosts(
    params: {
      q: string;
      author?: string;
      lang?: string;
      tag?: string;
      since?: string;
      until?: string;
      sort?: 'top' | 'latest';
      limit?: number;
      cursor?: string;
    },
    ctx: Context,
  ): Promise<SearchPostsResult> {
    const raw = await this.authedGet<{ posts: RawPostView[]; cursor?: string; hitsTotal?: number }>(
      'app.bsky.feed.searchPosts',
      {
        q: params.q,
        ...(params.author ? { author: params.author } : {}),
        ...(params.lang ? { lang: params.lang } : {}),
        ...(params.tag ? { tag: `#${params.tag}`.replace(/^##/, '#') } : {}),
        ...(params.since ? { since: params.since } : {}),
        ...(params.until ? { until: params.until } : {}),
        sort: params.sort ?? 'latest',
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
      (err) =>
        err.code === JsonRpcErrorCode.Forbidden
          ? forbidden('Bluesky refused this search.', {
              reason: 'search_refused',
              status: httpStatus(err),
              ...ctx.recoveryFor('search_refused'),
            })
          : undefined,
    );
    return {
      posts: (raw.posts ?? []).map(normalizePost),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
      ...(typeof raw.hitsTotal === 'number' ? { hitsTotal: raw.hitsTotal } : {}),
    };
  }

  /** Fetch an actor's public profile. */
  async getProfile(actor: string, ctx: Context): Promise<ActorProfile> {
    const raw = await this.get<RawActorView>('app.bsky.actor.getProfile', { actor }, ctx);
    return normalizeActor(raw);
  }

  /** Get an author's recent feed. */
  async getAuthorFeed(
    params: {
      actor: string;
      filter?: string;
      limit?: number;
      cursor?: string;
    },
    ctx: Context,
  ): Promise<AuthorFeedResult> {
    const raw = await this.get<{ feed: RawFeedItem[]; cursor?: string }>(
      'app.bsky.feed.getAuthorFeed',
      {
        actor: params.actor,
        ...(params.filter ? { filter: params.filter } : {}),
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
    );
    return {
      feed: (raw.feed ?? []).map(normalizeFeedItem),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /**
   * Read a feed generator's posts. Accepts the generator's AT-URI or its bsky.app page. The AppView
   * only finds a feed by its owner's DID, so a handle authority costs one `resolveHandle` first and
   * a DID authority costs nothing extra. Always unauthenticated: through the search session a
   * personalized feed would personalize to that one account for every caller.
   */
  async getFeed(
    params: { feed: string; limit?: number; cursor?: string },
    ctx: Context,
  ): Promise<FeedResult> {
    const ref = parseFeedRef(params.feed);
    if (!ref) throw validationError(FEED_REF_MESSAGE);
    const authority = ref.authority.startsWith('did:')
      ? ref.authority
      : await this.resolveFeedOwner(ref.authority, params.feed, ctx);
    const uri = feedGeneratorUri({ authority, rkey: ref.rkey });
    const raw = await this.get<{ feed: RawFeedItem[]; cursor?: string }>(
      'app.bsky.feed.getFeed',
      {
        feed: uri,
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
      (err) => feedError(err, uri, ctx),
    );
    return {
      posts: (raw.feed ?? []).map(normalizeFeedItem),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /** @internal DID of the handle that owns a feed; `feed_not_found` when no account answers to it. */
  private async resolveFeedOwner(handle: string, feed: string, ctx: Context): Promise<string> {
    const { did } = await this.get<{ did: string }>(
      'com.atproto.identity.resolveHandle',
      { handle },
      ctx,
      (err) =>
        httpStatus(err) === 400
          ? notFound(`No Bluesky account answers to the handle "${handle}" in ${feed}.`, {
              reason: 'feed_not_found',
              feed,
              ...ctx.recoveryFor('feed_not_found'),
            })
          : undefined,
    );
    return did;
  }

  /** Fetch the conversation thread for a post by AT-URI, with the author's reply gate when set. */
  async getPostThread(
    params: { uri: string; depth?: number; parentHeight?: number },
    ctx: Context,
  ): Promise<PostThreadResult> {
    const raw = await this.get<{ thread: RawThreadNode; threadgate?: RawThreadGate }>(
      'app.bsky.feed.getPostThread',
      {
        uri: params.uri,
        depth: params.depth ?? 6,
        parentHeight: params.parentHeight ?? 80,
      },
      ctx,
    );
    const threadgate = normalizeThreadGate(raw.threadgate);
    return { thread: normalizeThread(raw.thread), ...(threadgate ? { threadgate } : {}) };
  }

  /** Search for actors by name / handle fragment. */
  async searchActors(
    params: { q: string; limit?: number; cursor?: string },
    ctx: Context,
  ): Promise<SearchActorsResult> {
    const raw = await this.get<{ actors: RawActorView[]; cursor?: string }>(
      'app.bsky.actor.searchActors',
      {
        q: params.q,
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
    );
    return {
      actors: (raw.actors ?? []).map(normalizeActor),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /** Get followers of an actor. */
  async getFollowers(
    params: { actor: string; limit?: number; cursor?: string },
    ctx: Context,
  ): Promise<GraphResult> {
    const raw = await this.get<{
      followers: RawActorView[];
      subject: RawActorView;
      cursor?: string;
    }>(
      'app.bsky.graph.getFollowers',
      {
        actor: params.actor,
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
    );
    return {
      actors: (raw.followers ?? []).map(normalizeActor),
      subject: normalizeActor(raw.subject),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /** Get accounts an actor follows. */
  async getFollows(
    params: { actor: string; limit?: number; cursor?: string },
    ctx: Context,
  ): Promise<GraphResult> {
    const raw = await this.get<{ follows: RawActorView[]; subject: RawActorView; cursor?: string }>(
      'app.bsky.graph.getFollows',
      {
        actor: params.actor,
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
    );
    return {
      actors: (raw.follows ?? []).map(normalizeActor),
      subject: normalizeActor(raw.subject),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /**
   * Fetch real-time trending topics (app.bsky.unspecced.getTrends — unspecced endpoint, may change).
   * Each trend is backed by a feed generator: `topic` is its record key and `link` its bsky.app
   * page, so the feed's AT-URI is parsed from `link` rather than assembled from `topic`.
   */
  async getTrends(params: { limit?: number }, ctx: Context): Promise<TrendsResult> {
    const raw = await this.get<{
      trends: Array<{
        topic: string;
        displayName?: string;
        description?: string;
        link?: string;
        startedAt?: string;
        postCount?: number;
        status?: string;
        category?: string;
        actors?: RawActorView[];
      }>;
    }>('app.bsky.unspecced.getTrends', { limit: params.limit ?? 10 }, ctx);
    return {
      trends: (raw.trends ?? []).map((t) => {
        const link = t.link?.startsWith('/') ? `https://bsky.app${t.link}` : t.link;
        const feed = link ? parseFeedRef(link) : undefined;
        return {
          topic: t.topic,
          displayName: t.displayName ?? t.topic,
          ...(t.description ? { description: t.description } : {}),
          ...(link ? { link } : {}),
          ...(feed ? { feedUri: feedGeneratorUri(feed) } : {}),
          ...(t.startedAt ? { startedAt: t.startedAt } : {}),
          ...(typeof t.postCount === 'number' ? { postCount: t.postCount } : {}),
          ...(t.status ? { status: t.status } : {}),
          ...(t.category ? { category: t.category } : {}),
          ...(t.actors?.length ? { actors: t.actors.map(normalizeActor) } : {}),
        };
      }),
    };
  }
}

/**
 * @internal Map a failed `getFeed` onto `bsky_get_feed`'s reasons. The AppView names every case in
 * its error message rather than its error name — a missing feed and a post URI both answer
 * `InvalidRequest: could not find feed`, not the lexicon's `UnknownFeed` — so the message is what
 * is matched. Unrecognized failures keep their status-derived code.
 */
function feedError(err: McpError, uri: string, ctx: Context): McpError | undefined {
  const { error = '', message = '' } = xrpcError(err);
  const said = `${error}: ${message}`;
  if (err.code === JsonRpcErrorCode.Unauthorized) {
    return unauthorized(
      `${uri} is a personalized feed, and Bluesky serves it only to a signed-in account.`,
      { reason: 'feed_requires_login', feed: uri, ...ctx.recoveryFor('feed_requires_login') },
    );
  }
  if (/could not find feed|UnknownFeed/i.test(said)) {
    return notFound(`Bluesky has no feed at ${uri}.`, {
      reason: 'feed_not_found',
      feed: uri,
      ...ctx.recoveryFor('feed_not_found'),
    });
  }
  if (
    /could not resolve identity|feed unavailable|UpstreamFailure|Upstream server responded/i.test(
      said,
    )
  ) {
    return serviceUnavailable(
      `The feed generator behind ${uri} did not answer (Bluesky reported: ${message || error}).`,
      { reason: 'feed_unavailable', feed: uri, ...ctx.recoveryFor('feed_unavailable') },
    );
  }
  return;
}

// ---------------------------------------------------------------------------
// Init / accessor pattern
// ---------------------------------------------------------------------------

let _service: BlueskyService | undefined;

/**
 * Initialize the BlueskyService singleton. Call once in createApp setup(). Credentials enable post
 * search; no session is created until the first search.
 */
export function initBlueskyService(credentials?: SearchCredentials): void {
  _service = new BlueskyService(credentials);
}

/** Get the initialized BlueskyService singleton. Throws if not yet initialized. */
export function getBlueskyService(): BlueskyService {
  if (!_service) {
    throw new Error('BlueskyService not initialized — call initBlueskyService() in setup()');
  }
  return _service;
}

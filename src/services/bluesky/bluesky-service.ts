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
import {
  FEED_REF_MESSAGE,
  feedGeneratorUri,
  POST_COLLECTION,
  POST_URI_REF_MESSAGE,
  parseFeedRef,
  parsePostRef,
} from './at-syntax.js';
import { type SearchCredentials, SearchSession } from './search-session.js';
import type {
  ActorProfile,
  ActorSummary,
  AuthorFeedResult,
  Embed,
  FeedResult,
  GraphResult,
  Label,
  PostAuthor,
  PostThreadResult,
  PostView,
  QuotedRecordKind,
  QuotesResult,
  SearchActorsResult,
  SearchPostsResult,
  ThreadGate,
  ThreadGateRule,
  ThreadPost,
  TrendsResult,
  VerificationState,
  VerificationStatus,
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

/**
 * @internal Raw `app.bsky.actor.defs#verificationState`, on every actor view — `profileViewBasic`,
 * `profileView`, and `profileViewDetailed` alike. The lexicon requires all three fields; the whole
 * object is optional, and the AppView omits it for an account that is neither verified nor a
 * trusted verifier.
 */
interface RawVerificationState {
  trustedVerifierStatus: string;
  verifications: Array<{
    createdAt: string;
    isValid: boolean;
    issuer: string;
    issuerDisplayName?: string;
    issuerHandle?: string;
    uri: string;
  }>;
  verifiedStatus: string;
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
  verification?: RawVerificationState;
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

/** @internal The two statuses, verbatim. Undefined when the AppView sent no verification state. */
function verificationStatus(v: RawVerificationState | undefined): VerificationStatus | undefined {
  if (!v) return;
  return { verifiedStatus: v.verifiedStatus, trustedVerifierStatus: v.trustedVerifierStatus };
}

/**
 * @internal The full verification state for a profile lookup — the statuses and every issuance,
 * with an issuer's optional handle and display name carried only when the AppView sent them.
 */
function verificationState(v: RawVerificationState | undefined): VerificationState | undefined {
  if (!v) return;
  return {
    verifiedStatus: v.verifiedStatus,
    trustedVerifierStatus: v.trustedVerifierStatus,
    verifications: v.verifications.map((entry) => ({
      issuer: entry.issuer,
      ...(entry.issuerHandle ? { issuerHandle: entry.issuerHandle } : {}),
      ...(entry.issuerDisplayName ? { issuerDisplayName: entry.issuerDisplayName } : {}),
      uri: entry.uri,
      isValid: entry.isValid,
      createdAt: entry.createdAt,
    })),
  };
}

/** @internal An actor as the list views carry it: every profile field, verification narrowed. */
function normalizeActorSummary({ verification, ...actor }: RawActorView): ActorSummary {
  const status = verificationStatus(verification);
  return { ...normalizeActor(actor), ...(status ? { verification: status } : {}) };
}

function normalizeActor(r: RawActorView): ActorProfile {
  const verification = verificationState(r.verification);
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
    ...(verification ? { verification } : {}),
  };
}

/**
 * @internal Who wrote a post. The AppView attaches a `profileViewBasic` to every post view, which
 * also carries the account's own `createdAt`, its account-level moderation labels, and its pronouns
 * — account facts rather than post facts, declared by no post schema and rendered by no formatter.
 * Kept, they would reach a `structuredContent` reader alone. `bsky_get_profile` serves the rest.
 *
 * The two verification statuses are the one account fact kept: they say whether the account behind
 * the post is the verified one or a look-alike, which is what citing the post turns on.
 */
function normalizePostAuthor(r: RawActorView): PostAuthor {
  const verification = verificationStatus(r.verification);
  return {
    did: r.did,
    handle: r.handle,
    ...(r.displayName ? { displayName: r.displayName } : {}),
    ...(r.avatar ? { avatar: r.avatar } : {}),
    ...(verification ? { verification } : {}),
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

/**
 * @internal A quote post with the restatement of the queried post taken out of its embed. Every
 * `getQuotes` result quotes that one post, so the normalized `record` embed would repeat its text,
 * author, and attachments on every item — 27–48% of both response channels across three measured
 * pages. What stays is what the quoting post itself carries: the address and revision it points at,
 * whether that record is readable (`recordKind`), and the media it attached beside the quote. An
 * embed pointing anywhere else is left whole.
 */
function withoutRestatedTarget(post: PostView, targetUri: string): PostView {
  const embed = post.embed;
  if (embed?.type !== 'record' || embed.uri !== targetUri) return post;
  return {
    ...post,
    embed: {
      type: 'record',
      uri: embed.uri,
      cid: embed.cid,
      ...(embed.recordKind ? { recordKind: embed.recordKind } : {}),
      ...(embed.media ? { media: embed.media } : {}),
    },
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

/**
 * @internal How each cursored endpoint answers a cursor it cannot decode, measured live.
 * `getAuthorFeed` and `getQuotes` answer a bare `500 InternalServerError`, identically on every
 * attempt. `searchActors` answers `400 InvalidRequest: Invalid request`, the same body it gives any
 * other rejected parameter — but every other parameter it takes is validated before the request.
 * `searchPosts` answers `400 InvalidRequest: Invalid cursor format`, and names the parameter it
 * rejected in every other 400 too, so there the message has to name the cursor. `getFeed`,
 * `getFollowers`, and `getFollows` ignore a bad cursor and answer 200, so they are absent.
 */
const BAD_CURSOR = {
  'app.bsky.feed.getAuthorFeed': { status: 500 },
  'app.bsky.feed.getQuotes': { status: 500 },
  'app.bsky.actor.searchActors': { status: 400 },
  'app.bsky.feed.searchPosts': { status: 400, message: /cursor/i },
} satisfies Record<string, BadCursorAnswer>;

/** @internal The status a bad cursor is answered with, and the message it must carry when set. */
interface BadCursorAnswer {
  message?: RegExp;
  status: number;
}

/**
 * @internal Map the answer an endpoint gives an undecodable cursor, on a request that carried the
 * caller's cursor, onto `invalid_cursor`. That reason is final, so the retry loop leaves a 500
 * alone instead of spending seconds on the same answer. Without a cursor nothing the caller sent
 * could explain the status, and the failure keeps its ordinary handling — a 500 is retried as
 * transient, a 400 fails as it always has. The same holds for a request whose cursor Bluesky has
 * already accepted — the response budget's re-request of a page (`cursorAccepted`) — where a 500
 * cannot be the cursor.
 *
 * A 400 maps only when its envelope names `InvalidRequest`, the lexicon's parameter rejection. The
 * search session reads a 400 `ExpiredToken` / `InvalidToken` as its cue to renew the access token,
 * and a cursored search must still reach it with that body intact.
 */
function cursorError(
  err: McpError,
  cursor: string | undefined,
  lexicon: keyof typeof BAD_CURSOR,
  ctx: Context,
): McpError | undefined {
  const { status, message }: BadCursorAnswer = BAD_CURSOR[lexicon];
  if (!cursor || httpStatus(err) !== status) return;
  const envelope = xrpcError(err);
  if (status < 500 && envelope.error !== 'InvalidRequest') return;
  if (message && !message.test(envelope.message ?? '')) return;
  return validationError(
    `Bluesky could not continue from the cursor this request carried: ${lexicon} answered HTTP ${status}, which is how it reports a cursor it cannot decode.`,
    { reason: 'invalid_cursor', status, ...ctx.recoveryFor('invalid_cursor') },
  );
}

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
   * accounts in a block relationship with that account; it applies no mutes. `tag` is sent without
   * a leading `#`, as the lexicon asks — both forms match the same posts live.
   */
  async searchPosts(
    params: {
      q: string;
      author?: string;
      mentions?: string;
      lang?: string;
      tag?: string;
      domain?: string;
      url?: string;
      since?: string;
      until?: string;
      sort?: 'top' | 'latest';
      limit?: number;
      cursor?: string;
    },
    ctx: Context,
  ): Promise<SearchPostsResult> {
    const lexicon = 'app.bsky.feed.searchPosts';
    const raw = await this.authedGet<{ posts: RawPostView[]; cursor?: string; hitsTotal?: number }>(
      lexicon,
      {
        q: params.q,
        ...(params.author ? { author: params.author } : {}),
        ...(params.mentions ? { mentions: params.mentions } : {}),
        ...(params.lang ? { lang: params.lang } : {}),
        ...(params.tag ? { tag: params.tag.replace(/^#+/, '') } : {}),
        ...(params.domain ? { domain: params.domain } : {}),
        ...(params.url ? { url: params.url } : {}),
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
          : cursorError(err, params.cursor, lexicon, ctx),
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

  /**
   * Get an author's recent feed. With `includePins`, the profile's pinned post arrives first on the
   * first page, beyond `limit` and whatever the filter. A cursor the AppView cannot decode fails once
   * as `invalid_cursor`.
   */
  async getAuthorFeed(
    params: {
      actor: string;
      filter?: string;
      includePins?: boolean;
      limit?: number;
      cursor?: string;
      /** Bluesky already answered a request carrying `cursor` — see {@link cursorError}. */
      cursorAccepted?: boolean;
    },
    ctx: Context,
  ): Promise<AuthorFeedResult> {
    const lexicon = 'app.bsky.feed.getAuthorFeed';
    const raw = await this.get<{ feed: RawFeedItem[]; cursor?: string }>(
      lexicon,
      {
        actor: params.actor,
        ...(params.filter ? { filter: params.filter } : {}),
        ...(params.includePins ? { includePins: true } : {}),
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
      (err) => (params.cursorAccepted ? undefined : cursorError(err, params.cursor, lexicon, ctx)),
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
    const authority = await this.resolveAuthority(ref.authority, ctx, () =>
      notFound(
        `No Bluesky account answers to the handle "${ref.authority}" in ${feedGeneratorUri(ref)}.`,
        { reason: 'feed_not_found', feed: params.feed, ...ctx.recoveryFor('feed_not_found') },
      ),
    );
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
      feedUri: uri,
      posts: (raw.feed ?? []).map(normalizeFeedItem),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /**
   * @internal The DID an AT-URI authority names. A DID costs nothing; a handle costs one
   * `resolveHandle`, which answers an unknown handle with 400 — mapped onto the caller's own
   * not-found reason by `unknown`.
   */
  private async resolveAuthority(
    authority: string,
    ctx: Context,
    unknown: () => McpError,
  ): Promise<string> {
    if (authority.startsWith('did:')) return authority;
    const { did } = await this.get<{ did: string }>(
      'com.atproto.identity.resolveHandle',
      { handle: authority },
      ctx,
      (err) => (httpStatus(err) === 400 ? unknown() : undefined),
    );
    return did;
  }

  /**
   * The posts quoting one post, newest first, from `app.bsky.feed.getQuotes`. That endpoint answers
   * a handle authority, a missing post, and a post nobody quoted alike with 200 and an empty list,
   * so a handle is resolved to its DID first, and an empty *first* page is checked against
   * `app.bsky.feed.getPosts` — the one extra request, spent only there — to tell a missing post
   * (`post_not_found`) from one with no quotes. `getPosts` itself needs the DID form, answering a
   * handle authority with 500. Each result's embed has the restated queried post taken out.
   */
  async getQuotes(
    params: {
      uri: string;
      limit?: number;
      cursor?: string;
      /** Bluesky already answered a request carrying `cursor` — see {@link cursorError}. */
      cursorAccepted?: boolean;
    },
    ctx: Context,
  ): Promise<QuotesResult> {
    const ref = parsePostRef(params.uri);
    if (!ref) throw validationError(POST_URI_REF_MESSAGE);
    const postNotFound = (why: string) =>
      notFound(`Post not found: "${params.uri}" — ${why}.`, {
        reason: 'post_not_found',
        ...ctx.recoveryFor('post_not_found'),
      });
    const did = await this.resolveAuthority(ref.authority, ctx, () =>
      postNotFound(`no Bluesky account answers to the handle "${ref.authority}"`),
    );
    const uri = `at://${did}/${POST_COLLECTION}/${ref.rkey}`;
    const lexicon = 'app.bsky.feed.getQuotes';
    const raw = await this.get<{ posts: RawPostView[]; cursor?: string }>(
      lexicon,
      {
        uri,
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
      (err) => (params.cursorAccepted ? undefined : cursorError(err, params.cursor, lexicon, ctx)),
    );
    const result: QuotesResult = {
      uri,
      posts: (raw.posts ?? []).map((p) => withoutRestatedTarget(normalizePost(p), uri)),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
    if (result.posts.length > 0 || params.cursor) return result;
    const { posts: found } = await this.get<{ posts: RawPostView[] }>(
      'app.bsky.feed.getPosts',
      { uris: uri },
      ctx,
    );
    const target = found?.[0];
    if (!target) throw postNotFound('Bluesky has no post at that address');
    return typeof target.quoteCount === 'number'
      ? { ...result, quoteCount: target.quoteCount }
      : result;
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

  /**
   * Search for actors by name / handle fragment. A cursor the AppView cannot decode fails once as
   * `invalid_cursor`.
   */
  async searchActors(
    params: { q: string; limit?: number; cursor?: string },
    ctx: Context,
  ): Promise<SearchActorsResult> {
    const lexicon = 'app.bsky.actor.searchActors';
    const raw = await this.get<{ actors: RawActorView[]; cursor?: string }>(
      lexicon,
      {
        q: params.q,
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
      (err) => cursorError(err, params.cursor, lexicon, ctx),
    );
    return {
      actors: (raw.actors ?? []).map(normalizeActorSummary),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /** Get followers of an actor, in Bluesky's `latest` order unless `sort` asks for `top`. */
  async getFollowers(
    params: { actor: string; sort?: 'latest' | 'top'; limit?: number; cursor?: string },
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
        ...(params.sort ? { sort: params.sort } : {}),
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
    );
    return {
      actors: (raw.followers ?? []).map(normalizeActorSummary),
      subject: normalizeActorSummary(raw.subject),
      ...(raw.cursor ? { cursor: raw.cursor } : {}),
    };
  }

  /** Get accounts an actor follows, in Bluesky's `latest` order unless `sort` asks for `top`. */
  async getFollows(
    params: { actor: string; sort?: 'latest' | 'top'; limit?: number; cursor?: string },
    ctx: Context,
  ): Promise<GraphResult> {
    const raw = await this.get<{ follows: RawActorView[]; subject: RawActorView; cursor?: string }>(
      'app.bsky.graph.getFollows',
      {
        actor: params.actor,
        ...(params.sort ? { sort: params.sort } : {}),
        limit: params.limit ?? 25,
        ...(params.cursor ? { cursor: params.cursor } : {}),
      },
      ctx,
    );
    return {
      actors: (raw.follows ?? []).map(normalizeActorSummary),
      subject: normalizeActorSummary(raw.subject),
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

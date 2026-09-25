/**
 * @fileoverview Domain types for the Bluesky AT Protocol AppView service.
 * @module services/bluesky/types
 */

/** A Bluesky actor label (moderation / content warning). */
export interface Label {
  cts?: string;
  src?: string;
  val: string;
}

/**
 * Which member of the `app.bsky.embed.record#view` union stood in for an ordinary quoted post.
 * The first three mean the quote exists but cannot be read; the rest mean the quoted record is
 * not a post at all. `unknown` covers a union member added upstream after this mapping was written.
 */
export type QuotedRecordKind =
  | 'notFound'
  | 'blocked'
  | 'detached'
  | 'generator'
  | 'list'
  | 'starterPack'
  | 'labeler'
  | 'unknown';

/**
 * Normalized embed union — images, external link cards, quoted posts, or videos.
 * `app.bsky.embed.gallery#view` maps onto the `images` variant; `app.bsky.embed.recordWithMedia#view`
 * maps onto the `record` variant with its attached media nested under `media`.
 *
 * Every field here is one a reader can act on: a URL that leads to the attachment itself, the
 * address of a quoted record, or text a person wrote. Three upstream fields are deliberately not
 * mapped, so neither response channel carries what the other cannot — pixel dimensions on an image
 * or video (`aspectRatio`), which describe an asset the reader cannot see and which the asset itself
 * carries, and a link card's `thumb`, a preview of a page whose own URL, title, and description are
 * already here.
 */
export type Embed =
  | {
      type: 'images';
      images: Array<{ url: string; alt: string }>;
    }
  | { type: 'external'; uri: string; title: string; description: string }
  | {
      type: 'record';
      uri: string;
      /**
       * Content Identifier of the quoted record — the revision the quoting post points at. Empty on
       * the union members that carry no record of their own (see `recordKind`).
       */
      cid: string;
      text?: string;
      authorHandle?: string;
      /**
       * The quoted post's own embeds, from `app.bsky.embed.record#viewRecord.embeds`. A quote of an
       * image post carries the images here; without them such a quote reads as a bare line of text.
       * Absent for a quoted record that carries none, and for a quote nested inside another quote —
       * the AppView hydrates this field one level down and no further.
       */
      embeds?: Embed[];
      /** Media attached alongside the quote on a recordWithMedia embed. */
      media?: Embed;
      /**
       * How many attachments on this quote were left unmapped because it sits at the deepest level
       * of quote nesting this server follows. Absent — and, on everything the AppView has been
       * observed to send, always absent — when nothing was left behind. It exists so a quote that
       * had attachments is never presented as a quote that had none: fetch this record's `uri` as
       * its own post to read them.
       */
      omittedEmbeds?: number;
      /**
       * Absent for an ordinary quoted post. Set when the AppView returned something else in the
       * quote slot — an unreadable post or a non-post record. Those variants carry no text or author,
       * so `text` and `authorHandle` are absent, and `cid` is often the empty string; only `uri` is
       * dependable. `notFound`, `blocked`, and `detached` still identify a real post by `uri`.
       */
      recordKind?: QuotedRecordKind;
    }
  | {
      type: 'video';
      playlist?: string;
      thumbnail?: string;
      presentation?: string;
    }
  | { type: 'unknown'; raw: string };

/**
 * Bluesky's verdict on an account, from `app.bsky.actor.defs#verificationState`. Both are open
 * strings: the lexicon's `knownValues` are `valid`, `invalid`, and `none`, and a value added upstream
 * passes through verbatim. `invalid` is not `none` — the account was verified once and the
 * verification no longer holds.
 */
export interface VerificationStatus {
  /** Whether this account is a trusted verifier — one whose verifications Bluesky honors. */
  trustedVerifierStatus: string;
  /** Whether this account is verified by a trusted verifier. */
  verifiedStatus: string;
}

/** One verification a trusted verifier issued for an account (`#verificationView`). */
export interface Verification {
  createdAt: string;
  /** DID of the account that issued it. */
  issuer: string;
  /** Display name of the issuer — account-authored text. */
  issuerDisplayName?: string;
  issuerHandle?: string;
  /** Whether the verification still holds. */
  isValid: boolean;
  /** AT-URI of the verification record. */
  uri: string;
}

/**
 * The full verification state a profile lookup carries: the two statuses and every verification
 * issued by a trusted verifier. Actor lists and post authors carry {@link VerificationStatus} alone —
 * who issued what is a profile lookup.
 */
export interface VerificationState extends VerificationStatus {
  verifications: Verification[];
}

/** Public actor profile returned by getProfile / searchActors / etc. */
export interface ActorProfile {
  avatar?: string;
  createdAt?: string;
  description?: string;
  did: string;
  displayName?: string;
  followersCount?: number;
  followsCount?: number;
  handle: string;
  indexedAt?: string;
  labels?: Label[];
  /** AT-URI of pinned post, if present. */
  pinnedPostUri?: string;
  postsCount?: number;
  /**
   * Free-form pronouns the account set on its profile. `app.bsky.actor.profile` bounds it at 20
   * graphemes and restricts no character, so it is account-authored text like the bio.
   */
  pronouns?: string;
  /**
   * Verification state, absent when the AppView sent none — which it does for an account that is
   * neither verified nor a trusted verifier. Never synthesized as `none`.
   */
  verification?: VerificationState;
  /**
   * The one outbound link a profile carries in a field of its own, rather than inside the bio.
   * `format: "uri"` in the lexicon, so it is a URL by construction.
   */
  website?: string;
}

/**
 * An account as the actor lists carry it (`searchActors`, and the follow graph's entries and
 * subject): the profile fields a `profileView` has, with verification narrowed to the two statuses.
 */
export interface ActorSummary extends Omit<ActorProfile, 'verification'> {
  verification?: VerificationStatus;
}

/**
 * Who wrote a post, as a post view carries them. Deliberately narrower than {@link ActorProfile}:
 * the AppView attaches an `app.bsky.actor.defs#profileViewBasic` to every post, which also carries
 * the account's own `createdAt`, its account-level moderation labels, and its pronouns. None of
 * those describe the post, no post schema declares them, and no formatter renders them — carried
 * through they would reach a `structuredContent` reader and no other.
 *
 * Verification is the exception: whether the account behind a post is the verified one, rather
 * than a look-alike handle, decides whether the post can be cited, so its two statuses ride along.
 * Who issued the verification is a profile lookup: `bsky_get_profile` and the
 * `bsky://profile/{actor}` resource serve the full {@link ActorProfile} for any handle or DID on a
 * post.
 */
export interface PostAuthor {
  avatar?: string;
  did: string;
  displayName?: string;
  handle: string;
  /** Absent when the AppView sent no verification state for the account. */
  verification?: VerificationStatus;
}

/** A single post view (feed items + search results share this shape). */
export interface PostView {
  author: PostAuthor;
  cid: string;
  createdAt?: string;
  embed?: Embed;
  indexedAt?: string;
  labels?: Label[];
  likeCount?: number;
  /**
   * For feed items: true when the feed pinned this post to its top (`app.bsky.feed.defs#reasonPin`).
   * A pin says where the post sits, not when it was written — it is often older than the items below.
   */
  pinned?: boolean;
  quoteCount?: number;
  replyCount?: number;
  /** For replies: the AT-URI of the post the thread started from. */
  replyRootUri?: string;
  /** For replies: the immediate parent AT-URI. */
  replyToUri?: string;
  repostCount?: number;
  /** For feed items: when the repost was indexed. Absent unless this item is a repost. */
  repostedAt?: string;
  /** For feed items: who reposted this post. Absent when the item is the actor's own writing. */
  repostedBy?: { did: string; displayName?: string; handle: string };
  text: string;
  uri: string;
}

/**
 * Why a thread node returned fewer replies than its own `replyCount`.
 * `depth` — the reply tree stopped at this node, so its replies were never fetched. Re-rooting a
 * thread request at this node's AT-URI returns them.
 * `unavailable` — the AppView returned a replies array shorter than the post's own `replyCount`
 * and no request closes the gap. The difference is a mix of two causes the response cannot tell
 * apart: replies held back past the AppView's per-post limit (`getPostThread` has no cursor on
 * `replies`), and replies the counter still includes although they are gone from the index —
 * deleted, authored by a departed account, hidden by the thread author, or filtered by moderation.
 */
export type ThreadTruncationReason = 'depth' | 'unavailable';

/**
 * A thread node in a post thread response.
 * `notFound` and `blocked` nodes carry no post content — only the AT-URI the AppView reported
 * (and, for a blocked node, the author DID) on the otherwise-empty `post`.
 */
export interface ThreadPost {
  /** True when the AppView returned `app.bsky.feed.defs#blockedPost` — the author blocks this view. */
  blocked?: boolean;
  /**
   * Set on the topmost parent a budget-cut response kept — or on the target, when it kept none — to
   * the number of ancestors above it that the AppView returned and the response budget left out.
   * Re-rooting a request at this node's AT-URI reads them. Distinct from `parentChainTruncated`,
   * which is the AppView's own cut at `parentHeight`.
   */
  budgetOmittedParents?: number;
  /**
   * Set on a kept reply-tree node whose own replies the response budget cut: how many of the direct
   * replies the AppView returned for it were left out, each with everything below it. Re-rooting a
   * request at this node's AT-URI reads them. Never set on the target, which lists its cut replies
   * by AT-URI instead ({@link budgetOmittedReplyUris}).
   */
  budgetOmittedReplies?: number;
  /**
   * Set on the target of a budget-cut response: the AT-URIs of its direct replies that were left
   * out, in AppView order, each with everything below it. Re-rooting the target itself would
   * reproduce the same cut, so each is named to be fetched on its own.
   */
  budgetOmittedReplyUris?: string[];
  /** True when the AppView returned `app.bsky.feed.defs#notFoundPost` — deleted or never existed. */
  notFound?: boolean;
  parent?: ThreadPost;
  /**
   * True on the topmost node of the parent chain when that node is itself a reply — it carries a
   * `post.replyToUri` pointing at a post the response does not contain, so the chain was cut at the
   * requested parent height rather than reaching the start of the conversation. Set on the target
   * post itself when no parent was returned at all. Unlike a reply-tree shortfall this one is fully
   * recoverable: `parentHeight` is honored level for level, so re-rooting a request at this node's
   * AT-URI walks further up.
   */
  parentChainTruncated?: boolean;
  post: PostView;
  replies?: ThreadPost[];
  /**
   * True when this node's `post.replyCount` exceeds the replies the AppView returned for it.
   * Set only on the reply tree — parent-chain nodes never carry it, since a parent chain is
   * linear by construction and its siblings are out of scope for the request.
   */
  truncated?: boolean;
  /** Set alongside `truncated` — which of the two shortfalls this is. */
  truncationReason?: ThreadTruncationReason;
  /**
   * Set alongside `truncated` — how far this node's `replyCount` runs ahead of the replies it
   * carries. An upper bound on what is missing, not a count of existing replies: Bluesky's
   * counter keeps including replies that have left the index.
   */
  unreturnedReplies?: number;
}

/** A rule naming who may reply to a gated thread, normalized from `app.bsky.feed.threadgate`. */
export type ThreadGateRule = 'follower' | 'following' | 'list' | 'mentioned' | 'unknown';

/**
 * The reply restrictions a thread author set on their own post, from the `threadgate` the AppView
 * returns alongside a thread.
 */
export interface ThreadGate {
  /**
   * Who may reply. Absent means anyone; an empty array means nobody — the author turned replies
   * off. Replies posted before a rule was set stay in the thread.
   */
  allow?: ThreadGateRule[];
  /** AT-URIs of replies the thread author hid. */
  hiddenReplies: string[];
  /** AT-URI of the threadgate record itself. */
  uri: string;
}

/** Result of getPostThread — the thread tree plus the author's reply restrictions, when set. */
export interface PostThreadResult {
  thread: ThreadPost;
  threadgate?: ThreadGate;
}

/** Result of searchPosts. */
export interface SearchPostsResult {
  cursor?: string;
  hitsTotal?: number;
  posts: PostView[];
}

/** Result of getAuthorFeed. */
export interface AuthorFeedResult {
  cursor?: string;
  feed: PostView[];
}

/** Result of getFeed — a feed generator's posts. */
export interface FeedResult {
  cursor?: string;
  /**
   * The generator's AT-URI in the DID form the request was sent with, whatever form the input
   * took — a later request for the same feed reuses it rather than resolving the handle again.
   */
  feedUri: string;
  posts: PostView[];
}

/** Result of getQuotes — the posts quoting one post, newest first. */
export interface QuotesResult {
  cursor?: string;
  posts: PostView[];
  /**
   * The queried post's own `quoteCount`, read only when the first page came back empty and the
   * post's existence had to be checked. Absent otherwise.
   */
  quoteCount?: number;
  /** DID-form AT-URI of the post whose quotes these are — the form the request was sent in. */
  uri: string;
}

/** Result of searchActors. */
export interface SearchActorsResult {
  actors: ActorSummary[];
  cursor?: string;
}

/** Result of getFollowers / getFollows. */
export interface GraphResult {
  actors: ActorSummary[];
  cursor?: string;
  subject: ActorSummary;
}

/** A single trending topic. */
export interface TrendingTopic {
  /** Representative accounts posting about this topic. */
  actors?: ActorProfile[];
  category?: string;
  /** Bluesky's one-sentence summary of the story behind the trend. */
  description?: string;
  displayName: string;
  /**
   * AT-URI of the feed generator that collects the trend's posts, parsed from `link`. Absent when
   * `link` is missing or is not a feed page — never assembled from `topic` alone.
   */
  feedUri?: string;
  link?: string;
  postCount?: number;
  startedAt?: string;
  status?: string;
  /** Record key of the trend's feed generator — an identifier, not a search term. */
  topic: string;
}

/** Result of getTrends. */
export interface TrendsResult {
  trends: TrendingTopic[];
}

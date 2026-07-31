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
 */
export type Embed =
  | {
      type: 'images';
      images: Array<{ url: string; alt: string; aspectRatio?: { width: number; height: number } }>;
    }
  | { type: 'external'; uri: string; title: string; description: string; thumb?: string }
  | {
      type: 'record';
      uri: string;
      cid: string;
      text?: string;
      authorHandle?: string;
      /** Media attached alongside the quote on a recordWithMedia embed. */
      media?: Embed;
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
      aspectRatio?: { width: number; height: number };
    }
  | { type: 'unknown'; raw: string };

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
}

/** A single post view (feed items + search results share this shape). */
export interface PostView {
  author: ActorProfile;
  cid: string;
  createdAt?: string;
  embed?: Embed;
  indexedAt?: string;
  labels?: Label[];
  likeCount?: number;
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

/** A thread node in a post thread response. */
export interface ThreadPost {
  /** True when the API indicates this post was not found (deleted). */
  notFound?: boolean;
  parent?: ThreadPost;
  post: PostView;
  replies?: ThreadPost[];
  /** True when the API truncated deeper replies at this node. */
  truncated?: boolean;
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

/** Result of searchActors. */
export interface SearchActorsResult {
  actors: ActorProfile[];
  cursor?: string;
}

/** Result of getFollowers / getFollows. */
export interface GraphResult {
  actors: ActorProfile[];
  cursor?: string;
  subject: ActorProfile;
}

/** A single trending topic. */
export interface TrendingTopic {
  /** Representative accounts posting about this topic. */
  actors?: ActorProfile[];
  category?: string;
  displayName: string;
  link?: string;
  postCount?: number;
  startedAt?: string;
  status?: string;
  topic: string;
}

/** Result of getTrends. */
export interface TrendsResult {
  trends: TrendingTopic[];
}

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

/** Normalized embed union — images, external link cards, or quoted posts. */
export type Embed =
  | {
      type: 'images';
      images: Array<{ url: string; alt: string; aspectRatio?: { width: number; height: number } }>;
    }
  | { type: 'external'; uri: string; title: string; description: string; thumb?: string }
  | { type: 'record'; uri: string; cid: string; text?: string; authorHandle?: string }
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
  /** For replies: the immediate parent AT-URI. */
  replyToUri?: string;
  repostCount?: number;
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

/**
 * @fileoverview BlueskyService — AT Protocol AppView public read client.
 * Wraps https://api.bsky.app/xrpc/ with retry/timeout and response normalization.
 * @module services/bluesky/bluesky-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { config } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  ActorProfile,
  AuthorFeedResult,
  Embed,
  GraphResult,
  Label,
  PostView,
  QuotedRecordKind,
  SearchActorsResult,
  SearchPostsResult,
  ThreadPost,
  TrendsResult,
} from './types.js';

/** @internal Bluesky AppView base URL — api.bsky.app avoids the 403s that public.api.bsky.app returns for searchPosts from some IPs. */
const BASE_URL = 'https://api.bsky.app';

/** @internal Request timeout in milliseconds. */
const TIMEOUT_MS = 15_000;

/**
 * @internal User-Agent header sent on every request, derived from the package
 * manifest so a release cannot ship a stale version string.
 */
const USER_AGENT = `${config.mcpServerName}/${config.mcpServerVersion}`;

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
}

/** @internal Raw post record (lexicon fields). */
interface RawPostRecord {
  createdAt?: string;
  reply?: { parent?: { uri?: string }; root?: { uri?: string } };
  text: string;
}

/**
 * @internal Raw image view. `app.bsky.embed.images#view` names the small variant `thumb`;
 * `app.bsky.embed.gallery#viewImage` names it `thumbnail`.
 */
interface RawImageView {
  alt?: string;
  aspectRatio?: { width?: number; height?: number };
  fullsize?: string;
  thumb?: string;
  thumbnail?: string;
}

/**
 * @internal Raw quoted record — the `record` slot of `app.bsky.embed.record#view`. `$type` names
 * which union member arrived; only `#viewRecord` carries `author` and `value`.
 */
interface RawViewRecord {
  $type?: string;
  author?: RawActorView;
  cid?: string;
  uri?: string;
  value?: { text?: string };
}

/** @internal Raw embed from AppView — $type discriminated. */
interface RawEmbed {
  $type?: string;
  aspectRatio?: { width?: number; height?: number };
  cid?: string;
  external?: { uri?: string; title?: string; description?: string; thumb?: string };
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

/** @internal Raw thread node — can be a post, a "more" stub, or a "not found" stub. */
interface RawThreadNode {
  $type?: string;
  parent?: RawThreadNode;
  post?: RawPostView;
  replies?: RawThreadNode[];
}

/** @internal Raw repost/pin marker attached to a feed item (app.bsky.feed.defs#reasonRepost). */
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
      ...(img.aspectRatio?.width != null && img.aspectRatio?.height != null
        ? { aspectRatio: { width: img.aspectRatio.width, height: img.aspectRatio.height } }
        : {}),
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
 * @internal Map a quoted post onto the `record` variant, optionally carrying attached media.
 * A deleted, blocked, detached, or non-post record carries `recordKind` instead of text and author —
 * those variants have no such fields, and without the discriminant they read as an empty quote.
 */
function normalizeQuote(rec: RawViewRecord | undefined, media: Embed | undefined): Embed {
  const kind = quotedRecordKind(rec?.$type);
  return {
    type: 'record',
    uri: rec?.uri ?? '',
    cid: rec?.cid ?? '',
    ...(kind ? { recordKind: kind } : {}),
    ...(rec?.value?.text ? { text: rec.value.text } : {}),
    ...(rec?.author?.handle ? { authorHandle: rec.author.handle } : {}),
    ...(media ? { media } : {}),
  };
}

function normalizeEmbed(r: RawEmbed | undefined): Embed | undefined {
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
        ...(ext.thumb ? { thumb: ext.thumb } : {}),
      };
    }
    case 'record':
      return normalizeQuote(r.record, undefined);
    case 'recordWithMedia':
      return normalizeQuote(r.record?.record, normalizeEmbed(r.media));
    case 'video':
      return {
        type: 'video',
        ...(r.playlist ? { playlist: r.playlist } : {}),
        ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
        ...(r.presentation ? { presentation: r.presentation } : {}),
        ...(r.aspectRatio?.width != null && r.aspectRatio?.height != null
          ? { aspectRatio: { width: r.aspectRatio.width, height: r.aspectRatio.height } }
          : {}),
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
    author: normalizeActor(r.author),
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

/** @internal Normalize a feed item, carrying the repost marker through when the item is a repost. */
function normalizeFeedItem(item: RawFeedItem): PostView {
  const post = normalizePost(item.post);
  const by = item.reason?.by;
  if (!by || !(item.reason?.$type ?? '').endsWith('#reasonRepost')) return post;
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

/** @internal Sentinel PostView used for truncated/not-found thread stubs. */
const STUB_POST: PostView = { uri: '', cid: '', text: '', author: { did: '', handle: '' } };

function normalizeThread(node: RawThreadNode): ThreadPost {
  const typeStr = node.$type ?? '';
  if (typeStr.includes('threadViewPostMore')) {
    // The API returns a stub indicating there are more replies — surface as truncated
    return { post: STUB_POST, truncated: true };
  }
  if (typeStr.includes('threadViewPostNotFound') || !node.post) {
    return { post: STUB_POST, notFound: true };
  }
  const result: ThreadPost = { post: normalizePost(node.post) };
  if (node.parent) result.parent = normalizeThread(node.parent);
  if (node.replies?.length) result.replies = node.replies.map(normalizeThread);
  return result;
}

// ---------------------------------------------------------------------------
// BlueskyService class
// ---------------------------------------------------------------------------

/** Public-read AT Protocol AppView client. No authentication required. */
export class BlueskyService {
  /** @internal Build a full XRPC URL with query params. */
  private buildUrl(
    lexicon: string,
    params: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${BASE_URL}/xrpc/${lexicon}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** @internal Fetch JSON from the AppView with retry/timeout. Throws ServiceUnavailable on upstream failure. */
  private get<T>(
    lexicon: string,
    params: Record<string, string | number | boolean | undefined>,
    ctx: Context,
  ): Promise<T> {
    const url = this.buildUrl(lexicon, params);
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(
          url,
          TIMEOUT_MS,
          ctx as unknown as Parameters<typeof fetchWithTimeout>[2],
          {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: ctx.signal,
          },
        );
        const text = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
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
      {
        operation: `BlueskyService.${lexicon}`,
        // Context is a superset of RequestContext — the logger strips non-serializable fields.
        // biome-ignore lint/suspicious/noExplicitAny: ctx is a superset of RequestContext; cast is intentional
        context: ctx as any,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Public API methods
  // ---------------------------------------------------------------------------

  /** Full-text post search. */
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
    const raw = await this.get<{ posts: RawPostView[]; cursor?: string; hitsTotal?: number }>(
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

  /** Fetch the full conversation thread for a post by AT-URI. */
  async getPostThread(
    params: { uri: string; depth?: number; parentHeight?: number },
    ctx: Context,
  ): Promise<ThreadPost> {
    const raw = await this.get<{ thread: RawThreadNode }>(
      'app.bsky.feed.getPostThread',
      {
        uri: params.uri,
        depth: params.depth ?? 6,
        parentHeight: params.parentHeight ?? 80,
      },
      ctx,
    );
    return normalizeThread(raw.thread);
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

  /** Fetch real-time trending topics (app.bsky.unspecced.getTrends — unspecced endpoint, may change). */
  async getTrends(params: { limit?: number }, ctx: Context): Promise<TrendsResult> {
    const raw = await this.get<{
      trends: Array<{
        topic: string;
        displayName?: string;
        link?: string;
        startedAt?: string;
        postCount?: number;
        status?: string;
        category?: string;
        actors?: RawActorView[];
      }>;
    }>('app.bsky.unspecced.getTrends', { limit: params.limit ?? 10 }, ctx);
    return {
      trends: (raw.trends ?? []).map((t) => ({
        topic: t.topic,
        displayName: t.displayName ?? t.topic,
        ...(t.link
          ? {
              link: t.link.startsWith('/') ? `https://bsky.app${t.link}` : t.link,
            }
          : {}),
        ...(t.startedAt ? { startedAt: t.startedAt } : {}),
        ...(typeof t.postCount === 'number' ? { postCount: t.postCount } : {}),
        ...(t.status ? { status: t.status } : {}),
        ...(t.category ? { category: t.category } : {}),
        ...(t.actors?.length ? { actors: t.actors.map(normalizeActor) } : {}),
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Init / accessor pattern
// ---------------------------------------------------------------------------

let _service: BlueskyService | undefined;

/** Initialize the BlueskyService singleton. Call once in createApp setup(). */
export function initBlueskyService(): void {
  _service = new BlueskyService();
}

/** Get the initialized BlueskyService singleton. Throws if not yet initialized. */
export function getBlueskyService(): BlueskyService {
  if (!_service) {
    throw new Error('BlueskyService not initialized — call initBlueskyService() in setup()');
  }
  return _service;
}

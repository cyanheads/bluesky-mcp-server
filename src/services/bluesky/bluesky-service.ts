/**
 * @fileoverview BlueskyService — AT Protocol AppView public read client.
 * Wraps https://api.bsky.app/xrpc/ with retry/timeout and response normalization.
 * @module services/bluesky/bluesky-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  ActorProfile,
  AuthorFeedResult,
  Embed,
  GraphResult,
  Label,
  PostView,
  SearchActorsResult,
  SearchPostsResult,
  ThreadPost,
  TrendsResult,
} from './types.js';

/** @internal Bluesky AppView base URL — api.bsky.app avoids the 403s that public.api.bsky.app returns for searchPosts from some IPs. */
const BASE_URL = 'https://api.bsky.app';

/** @internal Request timeout in milliseconds. */
const TIMEOUT_MS = 15_000;

/** @internal User-Agent header sent on every request. */
const USER_AGENT = '@cyanheads/bluesky-mcp-server/0.1.0';

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
  reply?: { parent?: { uri?: string } };
  text: string;
}

/** @internal Raw embed from AppView — $type discriminated. */
interface RawEmbed {
  $type?: string;
  external?: { uri?: string; title?: string; description?: string; thumb?: string };
  images?: Array<{
    fullsize?: string;
    thumb?: string;
    alt?: string;
    aspectRatio?: { width?: number; height?: number };
  }>;
  record?: { uri?: string; cid?: string; author?: RawActorView; value?: { text?: string } };
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

/** @internal Raw feed item (post + optional reply context). */
interface RawFeedItem {
  post: RawPostView;
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

function normalizeEmbed(r: RawEmbed | undefined): Embed | undefined {
  if (!r) return;
  const type = r.$type ?? '';
  if (type.includes('embed.images') || r.images) {
    const images = (r.images ?? []).map((img) => ({
      url: img.fullsize ?? img.thumb ?? '',
      alt: img.alt ?? '',
      ...(img.aspectRatio?.width != null && img.aspectRatio?.height != null
        ? { aspectRatio: { width: img.aspectRatio.width, height: img.aspectRatio.height } }
        : {}),
    }));
    return { type: 'images', images };
  }
  if (type.includes('embed.external') || r.external) {
    const ext = r.external ?? {};
    return {
      type: 'external',
      uri: ext.uri ?? '',
      title: ext.title ?? '',
      description: ext.description ?? '',
      ...(ext.thumb ? { thumb: ext.thumb } : {}),
    };
  }
  if (type.includes('embed.record') || r.record) {
    const rec = r.record ?? {};
    return {
      type: 'record',
      uri: rec.uri ?? '',
      cid: rec.cid ?? '',
      ...(rec.value?.text ? { text: rec.value.text } : {}),
      ...(rec.author?.handle ? { authorHandle: rec.author.handle } : {}),
    };
  }
  return { type: 'unknown', raw: type };
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
  };
}

function normalizeThread(node: RawThreadNode): ThreadPost {
  const typeStr = node.$type ?? '';
  if (typeStr.includes('threadViewPostMore')) {
    // The API returns a stub indicating there are more replies — surface as truncated
    return {
      post: { uri: '', cid: '', text: '', author: { did: '', handle: '' } },
      truncated: true,
    };
  }
  if (typeStr.includes('threadViewPostNotFound') || !node.post) {
    return {
      post: { uri: '', cid: '', text: '', author: { did: '', handle: '' } },
      notFound: true,
    };
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
  private async get<T>(
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
      feed: (raw.feed ?? []).map((item) => normalizePost(item.post)),
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
        ...(t.link ? { link: t.link } : {}),
        ...(t.startedAt ? { startedAt: t.startedAt } : {}),
        ...(typeof t.postCount === 'number' ? { postCount: t.postCount } : {}),
        ...(t.status ? { status: t.status } : {}),
        ...(t.category ? { category: t.category } : {}),
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

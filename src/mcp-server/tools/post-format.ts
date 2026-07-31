/**
 * @fileoverview Shared markdown rendering for a normalized Bluesky post.
 * Every tool that emits posts into content[] renders through here, so the search,
 * author-feed, and thread formatters carry the same fields structuredContent does.
 * @module mcp-server/tools/post-format
 */

/**
 * The post fields the renderer reads. Structural rather than nominal so both the
 * service-layer `PostView` and each tool's Zod-inferred post shape satisfy it.
 */
export interface RenderablePost {
  author: {
    avatar?: string | undefined;
    did: string;
    displayName?: string | undefined;
    handle: string;
  };
  cid: string;
  createdAt?: string | undefined;
  /** Normalized embed union — narrowed at render time, since tool schemas type it as passthrough. */
  embed?: unknown;
  indexedAt?: string | undefined;
  labels?: Array<{ val: string }> | undefined;
  likeCount?: number | undefined;
  quoteCount?: number | undefined;
  replyCount?: number | undefined;
  replyRootUri?: string | undefined;
  replyToUri?: string | undefined;
  repostCount?: number | undefined;
  repostedAt?: string | undefined;
  repostedBy?: { did: string; displayName?: string | undefined; handle: string } | undefined;
  text: string;
  uri: string;
}

/**
 * @internal Headline for a quoted record that is not an ordinary post, keyed by the normalized
 * `recordKind`. Stating the case beats rendering a quote line with no text behind it.
 */
const QUOTED_RECORD_LABELS: Record<string, string> = {
  notFound: 'Quoted post unavailable — deleted or never existed',
  blocked: 'Quoted post unavailable — hidden by a block',
  detached: 'Quoted post unavailable — detached by its author',
  generator: 'Quoted feed generator (not a post)',
  list: 'Quoted list (not a post)',
  starterPack: 'Quoted starter pack (not a post)',
  labeler: 'Quoted labeler service (not a post)',
  unknown: 'Quoted record of an unrecognized type (not a post)',
};

/** @internal "Display Name (@handle)", falling back to "@handle" when no display name is set. */
function actorLabel(actor: { displayName?: string | undefined; handle: string }): string {
  return actor.displayName ? `${actor.displayName} (@${actor.handle})` : `@${actor.handle}`;
}

/**
 * Render a normalized embed into markdown lines. Recurses one level for the media
 * attached to a quote-with-media post; returns no lines when there is no embed.
 */
export function renderEmbedLines(embed: unknown): string[] {
  if (!embed || typeof embed !== 'object') return [];
  const e = embed as Record<string, unknown>;
  switch (e.type) {
    case 'images': {
      const images = (e.images ?? []) as Array<{ alt?: string; url?: string }>;
      if (images.length === 0) return [];
      const rendered = images.map((img) => `${img.url} [${img.alt}]`).join(', ');
      return [`📷 ${images.length} image(s): ${rendered}`];
    }
    case 'external':
      return [`🔗 [${e.title}](${e.uri}): ${e.description}`];
    case 'record': {
      const kind = typeof e.recordKind === 'string' ? e.recordKind : undefined;
      const label = kind
        ? (QUOTED_RECORD_LABELS[kind] ?? QUOTED_RECORD_LABELS.unknown)
        : 'Quoted post';
      const lines = [`💬 ${label}: \`${e.uri}\``];
      if (e.authorHandle) lines.push(`   by @${e.authorHandle}`);
      if (e.text) lines.push(`   > ${e.text}`);
      lines.push(...renderEmbedLines(e.media).map((line) => `   ${line}`));
      return lines;
    }
    case 'video': {
      const label = e.presentation === 'gif' ? '🎞 GIF' : '🎬 Video';
      const lines = [e.thumbnail ? `${label}: ${e.thumbnail}` : label];
      if (e.playlist) lines.push(`   Playlist: ${e.playlist}`);
      return lines;
    }
    case 'unknown':
      return [`📦 Unrecognized embed type: \`${e.raw}\``];
    default:
      return [];
  }
}

/**
 * Render one post as markdown lines. Callers own the surrounding structure —
 * separators, headings, and thread indentation.
 */
export function renderPostLines(post: RenderablePost): string[] {
  const lines: string[] = [];
  if (post.repostedBy) {
    const when = post.repostedAt ? ` · ${post.repostedAt}` : '';
    lines.push(`🔁 Reposted by ${actorLabel(post.repostedBy)} \`${post.repostedBy.did}\`${when}`);
  }
  lines.push(`### ${actorLabel(post.author)}`);
  lines.push(`**AT-URI:** \`${post.uri}\` | **CID:** \`${post.cid}\``);
  lines.push(`**Author DID:** \`${post.author.did}\``);
  lines.push(post.text);
  const meta: string[] = [];
  if (post.likeCount != null) meta.push(`${post.likeCount} likes`);
  if (post.repostCount != null) meta.push(`${post.repostCount} reposts`);
  if (post.replyCount != null) meta.push(`${post.replyCount} replies`);
  if (post.quoteCount != null) meta.push(`${post.quoteCount} quotes`);
  if (meta.length) lines.push(`*${meta.join(' · ')}*`);
  if (post.createdAt) lines.push(`*Created: ${post.createdAt}*`);
  if (post.indexedAt) lines.push(`*Indexed: ${post.indexedAt}*`);
  lines.push(...renderEmbedLines(post.embed));
  if (post.replyToUri) lines.push(`↩ Reply to \`${post.replyToUri}\``);
  if (post.replyRootUri) lines.push(`🧵 Thread root: \`${post.replyRootUri}\``);
  if (post.author.avatar) lines.push(`**Avatar:** ${post.author.avatar}`);
  if (post.labels?.length) lines.push(`**Labels:** ${post.labels.map((l) => l.val).join(', ')}`);
  return lines;
}

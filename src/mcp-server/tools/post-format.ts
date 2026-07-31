/**
 * @fileoverview Shared markdown rendering for a normalized Bluesky post.
 * Every tool that emits posts into content[] renders through here, so the search,
 * author-feed, and thread formatters carry the same fields structuredContent does.
 * Also home to the two framings every formatter on this server puts around
 * Bluesky-authored text: {@link quoteUserText} for text that gets lines of its own —
 * post bodies, quoted-post bodies, profile bios, image alt text, link-card titles and
 * descriptions — and {@link inlineUserText} for the values that render inside a line
 * the server writes, such as a display name in a heading. Either way, third-party text
 * never contributes structure to the markdown around it.
 * @module mcp-server/tools/post-format
 */

/**
 * Frame Bluesky-authored text as quoted data. Every line is prefixed with `> `, so a
 * post or bio carrying its own `###` heading, `---` rule, or ``` fence renders inside
 * the quote instead of merging with the surrounding structure the tool itself emits.
 *
 * Blank lines render as a bare `>` rather than being passed through: an unprefixed
 * blank line closes the blockquote, and the next `###` or `---` in the same text would
 * then land at the top level — the collision this framing exists to prevent. A fenced
 * code block would not hold here either, since text containing its own triple backtick
 * closes the fence early and continues outside it.
 *
 * Returns no lines for empty text, so an image-only post renders without a stray quote
 * marker.
 */
export function quoteUserText(text: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => (line.trim() === '' ? '>' : `> ${line}`));
}

/**
 * Frame a Bluesky-authored value that renders inside a line the server wrote — a display
 * name in a `###` heading, a moderation label in a `**Labels:**` list. A blockquote is
 * the wrong shape for these: they are identity labels, not bodies, and quoting them
 * would push the heading they belong to onto a line of its own.
 *
 * The escape those positions are open to is a line break, so every run of line
 * terminators collapses to a single space. Nothing else is stripped — the value still
 * reads as written, and `structuredContent` carries it byte-for-byte either way. Line
 * breaks are not hypothetical here: `app.bsky.actor.profile` bounds `displayName` by
 * graphemes alone and permits any character, and live accounts already carry two-line
 * display names.
 */
export function inlineUserText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

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

/**
 * "Display Name (@handle)", falling back to "@handle" when no display name is set — or
 * when the one set is nothing but line breaks. The handle needs no framing: the lexicon
 * gives it `format: "handle"`, so it is a dotted domain by construction.
 */
export function actorLabel(actor: { displayName?: string | undefined; handle: string }): string {
  const name = actor.displayName ? inlineUserText(actor.displayName) : '';
  return name ? `${name} (@${actor.handle})` : `@${actor.handle}`;
}

/** @internal Indent an embed's detail lines under the line that introduces them. */
function indent(lines: string[]): string[] {
  return lines.map((line) => `   ${line}`);
}

/**
 * Render a normalized embed into markdown lines. Recurses one level for the media
 * attached to a quote-with-media post; returns no lines when there is no embed.
 */
export function renderEmbedLines(embed: unknown): string[] {
  if (!embed || typeof embed !== 'object') return [];
  const e = embed as Record<string, unknown>;
  switch (e.type) {
    /**
     * Alt text is the poster's own writing and the lexicon puts no length or character
     * bound on it, so it gets its own quoted lines rather than riding inline after the
     * URL — one newline in an alt string would otherwise carry the rest of it out to the
     * top level. That splits the images across lines too, since a per-image quote block
     * has nothing to hang off a comma-joined list.
     */
    case 'images': {
      const images = (e.images ?? []) as Array<{ alt?: string; url?: string }>;
      if (images.length === 0) return [];
      const lines = [`📷 ${images.length} image(s):`];
      for (const img of images) {
        lines.push(`   ${img.url}`);
        if (img.alt) lines.push(...indent(quoteUserText(img.alt)));
      }
      return lines;
    }
    /**
     * A link card's title and description are set by the poster, not fetched from the
     * linked page, and the lexicon bounds neither — descriptions of 20,000 characters
     * with line breaks in them are ordinary. Both are quoted under their own labels, and
     * the URL renders bare rather than as the target of a `[title](uri)` link, so no
     * part of the card can close the link syntax and continue outside it.
     */
    case 'external': {
      const lines = [`🔗 Link card: ${e.uri}`];
      if (typeof e.title === 'string' && e.title.trim()) {
        lines.push('   Title:', ...indent(quoteUserText(e.title)));
      }
      if (typeof e.description === 'string' && e.description.trim()) {
        lines.push('   Description:', ...indent(quoteUserText(e.description)));
      }
      return lines;
    }
    case 'record': {
      const kind = typeof e.recordKind === 'string' ? e.recordKind : undefined;
      const label = kind
        ? (QUOTED_RECORD_LABELS[kind] ?? QUOTED_RECORD_LABELS.unknown)
        : 'Quoted post';
      const lines = [`💬 ${label}: \`${e.uri}\``];
      if (e.authorHandle) lines.push(`   by @${e.authorHandle}`);
      if (typeof e.text === 'string') {
        lines.push(...indent(quoteUserText(e.text)));
      }
      lines.push(...indent(renderEmbedLines(e.media)));
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
  lines.push(...quoteUserText(post.text));
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
  if (post.labels?.length)
    lines.push(`**Labels:** ${post.labels.map((l) => inlineUserText(l.val)).join(', ')}`);
  return lines;
}

/**
 * @fileoverview Shared markdown rendering for a normalized Bluesky post.
 * Every tool that emits posts into content[] renders through here, so the search,
 * author-feed, and thread formatters carry the same fields structuredContent does —
 * every field of a normalized post and of its embed, with nothing left to one channel.
 * {@link renderLabelList} is here for the same reason, since a moderation label reads
 * the same on a post as on a profile.
 *
 * Also home to the two framings every formatter on this server puts around
 * Bluesky-authored text: {@link quoteUserText} for text that gets lines of its own —
 * post bodies, quoted-post bodies, profile bios, image alt text, link-card titles and
 * descriptions — and {@link inlineUserText} for the values that render inside a line
 * the server writes, such as a display name in a heading. Either way, third-party text
 * never contributes structure to the markdown around it.
 *
 * Nothing here indents past three spaces. CommonMark reads four leading spaces as an
 * indented code block, and a code block would render the blockquote framing as literal
 * characters — so depth is carried by labels and by the emoji that introduce each block,
 * and callers with a tree to render put it in the author heading rather than the margin.
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
  labels?: Array<{ val: string; src?: string | undefined; cts?: string | undefined }> | undefined;
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

/**
 * Render a moderation label list into the text of one line — each label's value, then the labeler
 * that applied it and when, keyed rather than positional. Shared so a label reads the same on a
 * post as on a profile.
 *
 * Only the value takes the inline framing: `label.val` is bounded at 128 characters with no
 * pattern and is written by third-party labelers, so a line break in one would carry the rest of
 * the list out of the line. `src` is a DID and `cts` an ISO 8601 timestamp, neither of which a
 * labeler chooses the shape of.
 */
export function renderLabelList(
  labels: ReadonlyArray<{ val: string; src?: string | undefined; cts?: string | undefined }>,
): string {
  return labels
    .map((l) => {
      const parts = [inlineUserText(l.val)];
      if (l.src) parts.push(`src:${l.src}`);
      if (l.cts) parts.push(`cts:${l.cts}`);
      return parts.join(' ');
    })
    .join(', ');
}

/**
 * @internal Column the detail lines under an embed sit at. Three spaces is the deepest a line can
 * go and still read as markdown: CommonMark opens an indented code block at four, and a code block
 * renders the blockquote framing around user text as literal characters instead of a quote.
 */
const DETAIL_INDENT = '   ';

/**
 * Render a normalized embed into markdown lines; returns no lines when there is no embed.
 *
 * Every field of every variant lands in these lines. The normalized `Embed` union carries only what
 * a reader can act on — the URL of each attachment, the address and revision of a quoted record,
 * and the text a person wrote — so a field reaching `structuredContent` and not `content[]` is a
 * gap here rather than a value worth leaving out.
 *
 * Recurses for the media attached alongside a quote and for the quoted post's own embeds, both of
 * which the service normalizes under the `record` variant. Pass `nested: true` when rendering into
 * a block the caller will indent, so the detail column is not applied twice.
 */
export function renderEmbedLines(embed: unknown, nested = false): string[] {
  if (!embed || typeof embed !== 'object') return [];
  const e = embed as Record<string, unknown>;
  /**
   * The one column shift, and the whole depth budget: an embed rendered inside another has already
   * been shifted by its caller, so it adds nothing further and its own details land in the same
   * column. Nesting is carried by the `📷` / `🔗` / `💬` line that introduces each block and by the
   * label above it, never by the margin — stacking indents would push a quote of an image post past
   * the code-block threshold on its second level.
   */
  const detail = (out: string[]): string[] =>
    nested ? out : out.map((line) => `${DETAIL_INDENT}${line}`);
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
        lines.push(...detail([`${img.url}`]));
        if (img.alt) lines.push(...detail(quoteUserText(img.alt)));
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
        lines.push(...detail(['Title:', ...quoteUserText(e.title)]));
      }
      if (typeof e.description === 'string' && e.description.trim()) {
        lines.push(...detail(['Description:', ...quoteUserText(e.description)]));
      }
      return lines;
    }
    /**
     * The two attachment blocks under a quote belong to different posts — `embeds` to the post
     * being quoted, `media` to the post doing the quoting — so each is named. Unlabelled they
     * render as two image blocks under one `💬` heading with nothing to say whose they are.
     */
    case 'record': {
      const kind = typeof e.recordKind === 'string' ? e.recordKind : undefined;
      const label = kind
        ? (QUOTED_RECORD_LABELS[kind] ?? QUOTED_RECORD_LABELS.unknown)
        : 'Quoted post';
      /**
       * The quoted record's address and revision on one line, the same pair `renderPostLines`
       * emits for the post doing the quoting — a quote is a post-shaped block, and it was the one
       * such block that named no CID. Absent on the union members that carry no record of their
       * own, where an empty pair would read as a CID that failed to load.
       */
      const cid = typeof e.cid === 'string' ? e.cid : '';
      const lines = [`💬 ${label}: \`${e.uri}\`${cid ? ` | CID: \`${cid}\`` : ''}`];
      if (e.authorHandle) lines.push(...detail([`by @${e.authorHandle}`]));
      if (typeof e.text === 'string') {
        lines.push(...detail(quoteUserText(e.text)));
      }
      const quotedEmbeds = (Array.isArray(e.embeds) ? e.embeds : []).flatMap((inner) =>
        renderEmbedLines(inner, true),
      );
      if (quotedEmbeds.length) {
        lines.push(...detail(['Attached to the quoted post:', ...quotedEmbeds]));
      }
      const attachedMedia = renderEmbedLines(e.media, true);
      if (attachedMedia.length) {
        lines.push(...detail(['Attached to the post that quoted it:', ...attachedMedia]));
      }
      /**
       * A quote at the deepest level of nesting the service follows. Stating the shortfall keeps it
       * from reading as a quote that simply had nothing attached — the same disclosure the reply
       * tree and the parent chain make about what a response does not contain.
       */
      const omitted = typeof e.omittedEmbeds === 'number' ? e.omittedEmbeds : 0;
      if (omitted > 0) {
        lines.push(
          ...detail([
            `*[${omitted} attachment${omitted === 1 ? '' : 's'} on this quote ${omitted === 1 ? 'was' : 'were'} not returned — quotes nested this deep are not followed. Fetch the AT-URI above to read them]*`,
          ]),
        );
      }
      return lines;
    }
    case 'video': {
      const label = e.presentation === 'gif' ? '🎞 GIF' : '🎬 Video';
      const lines = [e.thumbnail ? `${label}: ${e.thumbnail}` : label];
      if (e.playlist) lines.push(...detail([`Playlist: ${e.playlist}`]));
      return lines;
    }
    case 'unknown':
      return [`📦 Unrecognized embed type: \`${e.raw}\``];
    default:
      return [];
  }
}

/**
 * Render one post as markdown lines, every line at column zero. Callers own the surrounding
 * structure — separators, headings, and the position of the post within a thread.
 *
 * `headingPrefix` is inserted into the author heading, which is where a caller with a tree to
 * render puts the depth: nothing this renderer emits may be shifted right, since the detail lines
 * under an embed already sit at the three-space limit an indented code block leaves.
 */
export function renderPostLines(post: RenderablePost, headingPrefix = ''): string[] {
  const lines: string[] = [];
  if (post.repostedBy) {
    const when = post.repostedAt ? ` · ${post.repostedAt}` : '';
    lines.push(`🔁 Reposted by ${actorLabel(post.repostedBy)} \`${post.repostedBy.did}\`${when}`);
  }
  lines.push(`### ${headingPrefix}${actorLabel(post.author)}`);
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
  if (post.labels?.length) lines.push(`**Labels:** ${renderLabelList(post.labels)}`);
  return lines;
}

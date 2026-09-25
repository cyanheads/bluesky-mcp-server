/**
 * @fileoverview Shared markdown rendering for a normalized Bluesky post.
 * Every tool that emits posts into content[] renders through here, so the search, feed,
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

/** @internal Letters and digits — what makes an `_` intraword, where it can neither open nor close emphasis. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** @internal Unicode punctuation and symbols, as CommonMark's flanking rules classify them. */
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** @internal A bare URL in user text. It stops at whitespace, `<`, `>`, and a backtick. */
const URL_RUN = /https?:\/\/[^\s<>`]+/g;

/**
 * @internal Everything CommonMark (with GFM strikethrough) reads as inline syntax: a backslash, a
 * code-span backtick, link and image brackets, an emphasis or strikethrough delimiter run, a `<`
 * that opens a tag, comment, declaration, or autolink — an email autolink's local part may open
 * with a digit or a symbol (`<1user@host>`), so a `<` before one that reaches an `@` counts — and an
 * `&` that opens an entity or numeric character reference. Scanned in one pass, so no replacement
 * is ever read again — the `&lt;` a `<` becomes is never taken for an entity to escape.
 */
const INLINE_SYNTAX =
  /\\|`|\[|\]|\*+|_+|~+|<(?=[A-Za-z/!?]|[\w.!#$%&'*+/=?^`{|}~-]+@)|&(?=#?[A-Za-z0-9]+;)/g;

/** @internal An emphasis-capable delimiter run found inside a URL, with what it could do there. */
interface UrlDelimiter {
  canClose: boolean;
  canOpen: boolean;
  char: string;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isPunctuation = (c: string | undefined) => c !== undefined && PUNCTUATION.test(c);

/**
 * @internal Whether a delimiter run can open and close emphasis, by CommonMark's flanking rules.
 * `prev` and `next` are the characters either side of the run; the edge of the text counts as
 * whitespace.
 */
function flanking(char: string, prev: string | undefined, next: string | undefined): UrlDelimiter {
  const left = !isSpace(next) && (!isPunctuation(next) || isSpace(prev) || isPunctuation(prev));
  const right = !isSpace(prev) && (!isPunctuation(prev) || isSpace(next) || isPunctuation(next));
  if (char !== '_') return { char, canOpen: left, canClose: right };
  return {
    char,
    canOpen: left && (!right || isPunctuation(prev)),
    canClose: right && (!left || isPunctuation(next)),
  };
}

/**
 * Backslash-escape the inline Markdown and entity-encode the raw HTML in Bluesky-authored text —
 * only what a CommonMark renderer would act on, so text that carries none of it is unchanged.
 *
 * `_` inside a word is left alone (`snake_case`), since CommonMark never reads it as emphasis there,
 * and so are `<` and `&` when nothing could follow them into a tag or an entity (`a < b`, `AT&T`).
 * Inside a bare `http(s)://` URL, `_ * ~ [ ]` also stay as written, so a URL copied out of the
 * rendered text still resolves — with two exceptions that would otherwise let a URL carry live
 * syntax: `]` before `(` (the join of an inline link), and a URL `_`, `*`, or `~` that another URL
 * delimiter of the same character could pair with into emphasis or strikethrough. Neither occurs in
 * an ordinary URL. An `inline` value also escapes any URL `*` that could open or close emphasis on
 * its own, since the line around it may carry the server's own `**` — a trend name renders inside
 * strong emphasis, and a URL ending in `*` there would close it.
 */
function escapeInlineMarkdown(text: string, inline: boolean): string {
  const urls = [...text.matchAll(URL_RUN)].map((m) => [m.index, m.index + m[0].length] as const);
  const inUrl = (at: number) => urls.some(([start, end]) => at >= start && at < end);
  const intraword = (at: number, length: number) =>
    WORD_CHAR.test(text[at - 1] ?? '') && WORD_CHAR.test(text[at + length] ?? '');

  /** Delimiter characters whose URL runs could pair with one another, and so are escaped too. */
  const pairable = new Set<string>();
  const seen: UrlDelimiter[] = [];
  for (const m of text.matchAll(/\*+|_+|~+/g)) {
    const [run] = m;
    if (!inUrl(m.index) || (run[0] === '_' && intraword(m.index, run.length))) continue;
    const delimiter = flanking(run[0] ?? '', text[m.index - 1], text[m.index + run.length]);
    if (delimiter.canClose && seen.some((d) => d.char === delimiter.char && d.canOpen)) {
      pairable.add(delimiter.char);
    }
    if (inline && delimiter.char === '*' && (delimiter.canOpen || delimiter.canClose)) {
      pairable.add('*');
    }
    seen.push(delimiter);
  }

  return text.replace(INLINE_SYNTAX, (match: string, at: number) => {
    const next = text[at + match.length];
    switch (match[0]) {
      case '\\':
        return next === undefined || /[!-/:-@[-`{-~\r\n]/.test(next) ? '\\\\' : match;
      case '<':
        return '&lt;';
      case '&':
        return '&amp;';
      case '`':
        return '\\`';
      case '[':
        return inUrl(at) ? match : '\\[';
      case ']':
        return inUrl(at) && next !== '(' ? match : '\\]';
      default: {
        if (match[0] === '_' && intraword(at, match.length)) return match;
        if (inUrl(at) && !pairable.has(match[0] ?? '')) return match;
        return match.replace(/./g, '\\$&');
      }
    }
  });
}

/**
 * @internal The block syntax that survives inside a blockquote, escaped at the start of one quoted
 * line: an ATX heading's `#` run, a `-` or `+` bullet, an ordered-list `N.` / `N)` marker, and a line
 * of nothing but `=` or `-` (a setext underline or a thematic break). `*`, `_`, backtick, and `~`
 * lines are already inert after {@link escapeInlineMarkdown}. The quote markers a line opens with are
 * kept, so a user's own `>` still nests, and the rules apply to what follows them.
 *
 * Up to three characters of indentation are allowed before a marker, tabs included. A tab is one to
 * four columns wide depending on the column it starts at, and that column depends on where the
 * caller puts the quote (top level, or the three-space detail column), so a tab is counted at its
 * narrowest: the rules never miss a marker CommonMark would read, and at worst escape one on a line
 * wide enough to render as literal code.
 */
function escapeLineStart(line: string): string {
  const [markers = ''] = line.match(/^(?:[ \t]{0,3}>[ \t]?)*/) ?? [];
  const rest = line
    .slice(markers.length)
    .replace(/^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/, '$1\\$2')
    .replace(/^([ \t]{0,3})([-+])(?=[ \t]|$)/, '$1\\$2')
    .replace(/^([ \t]{0,3})(\d{1,9})([.)])(?=[ \t]|$)/, '$1$2\\$3')
    .replace(/^([ \t]{0,3})(=+[ \t]*)$/, '$1\\$2')
    .replace(/^([ \t]{0,3})(-[ \t-]*)$/, '$1\\$2');
  return markers + rest;
}

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
 * The quote keeps the text's structure from reaching the page, but Markdown stays live inside
 * it — emphasis, links, images, code, lists, headings, raw HTML. So what CommonMark would
 * interpret is escaped too (see {@link escapeInlineMarkdown} and {@link escapeLineStart}): a
 * rendering client shows the characters the author typed, and an LLM reading the raw text sees
 * them with a backslash in front. A line that opens with `>` still nests one quote deeper.
 * `structuredContent` carries the original string.
 *
 * Returns no lines for empty text, so an image-only post renders without a stray quote
 * marker.
 */
export function quoteUserText(text: string): string[] {
  if (!text) return [];
  return escapeInlineMarkdown(text, false)
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '>' : `> ${escapeLineStart(line)}`));
}

/**
 * Frame a Bluesky-authored value that renders inside a line the server wrote — a display
 * name in a `###` heading, a moderation label in a `**Labels:**` list. A blockquote is
 * the wrong shape for these: they are identity labels, not bodies, and quoting them
 * would push the heading they belong to onto a line of its own.
 *
 * The block-level escape those positions are open to is a line break, so every run of line
 * terminators collapses to a single space. Line breaks are not hypothetical here:
 * `app.bsky.actor.profile` bounds `displayName` by graphemes alone and permits any character,
 * and live accounts already carry two-line display names. The inline syntax a renderer would
 * act on inside the line — a `**` that closes the heading's own emphasis, a raw `<img>`, a link —
 * is escaped as in {@link quoteUserText}, and so is a trailing `#` run, which an ATX heading the
 * value ends would drop as its closing sequence. `structuredContent` carries the value
 * byte-for-byte either way.
 */
export function inlineUserText(text: string): string {
  return escapeInlineMarkdown(text.replace(/[\r\n]+/g, ' ').trim(), true).replace(
    /(^|[ \t])(#+)$/,
    '$1\\$2',
  );
}

/** @internal A line inside a blockquote, at the top level or in the three-space detail column. */
const QUOTE_LINE = /^ {0,3}>/;

/**
 * End every blockquote before the line after it: a blank line goes in wherever a quoted line is
 * followed by one that is neither quoted nor blank. CommonMark reads a line that follows a
 * blockquote paragraph as a lazy continuation of it, so without the break a rendering client shows
 * the server line underneath — a post's counts, a `🔗 Link card:` or `💬 Quoted post:` heading, the
 * next image URL, a `**Labels:**` line — inside the user's quote, blurring the one boundary the
 * framing exists to draw. Run it over the lines a formatter assembles around {@link quoteUserText};
 * a blank line changes nothing else about how those lines render. The lines' last line may still be
 * a quote, since whatever follows a block is the caller's: every caller here follows one with a
 * blank line or with the end of the text. An entry may carry its own line breaks (`'\nnext'`), so
 * the test reads the last line of one entry and the first line of the next.
 */
export function closeQuotes(lines: readonly string[]): string[] {
  const out: string[] = [];
  lines.forEach((entry, i) => {
    out.push(entry);
    const next = lines[i + 1];
    if (next === undefined) return;
    const last = entry.slice(entry.lastIndexOf('\n') + 1);
    const first = next.split('\n', 1)[0] ?? '';
    if (QUOTE_LINE.test(last) && first.trim() !== '' && !QUOTE_LINE.test(first)) out.push('');
  });
  return out;
}

/** An account's two verification statuses, as every actor-bearing schema declares them. */
export interface RenderableVerification {
  trustedVerifierStatus: string;
  verifiedStatus: string;
}

/**
 * The two verification statuses as a suffix for the line that already carries an account's DID —
 * ` | **Verified:** valid | **Trusted verifier:** none` — or nothing when the AppView sent no
 * verification state. Both values render verbatim: they are open strings, and `invalid` must never
 * read as verified. AppView-assigned rather than account-authored, so they take no framing.
 */
export function verificationSuffix(verification: RenderableVerification | undefined): string {
  if (!verification) return '';
  return ` | **Verified:** ${verification.verifiedStatus} | **Trusted verifier:** ${verification.trustedVerifierStatus}`;
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
    verification?: RenderableVerification | undefined;
  };
  cid: string;
  createdAt?: string | undefined;
  /** Normalized embed union — narrowed at render time, since tool schemas type it as passthrough. */
  embed?: unknown;
  indexedAt?: string | undefined;
  labels?: Array<{ val: string; src?: string | undefined; cts?: string | undefined }> | undefined;
  likeCount?: number | undefined;
  pinned?: boolean | undefined;
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
  generator: 'Quoted feed generator (not a post) — read its posts with bsky_get_feed',
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
 * which the service normalizes under the `record` variant. Every quote in the lines ends before the
 * server line after it ({@link closeQuotes}).
 */
export function renderEmbedLines(embed: unknown): string[] {
  return closeQuotes(embedLines(embed, false));
}

/**
 * @internal {@link renderEmbedLines} before its quotes are ended. `nested` renders into a block the
 * caller indents, so the detail column is not applied twice.
 */
function embedLines(embed: unknown, nested: boolean): string[] {
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
        embedLines(inner, true),
      );
      if (quotedEmbeds.length) {
        lines.push(...detail(['Attached to the quoted post:', ...quotedEmbeds]));
      }
      const attachedMedia = embedLines(e.media, true);
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
 *
 * Every quote inside ends before the server line after it ({@link closeQuotes}). The last line may
 * be the post body's quote, so a caller follows the post with a blank line or the end of its text.
 */
export function renderPostLines(post: RenderablePost, headingPrefix = ''): string[] {
  const lines: string[] = [];
  if (post.pinned) lines.push('📌 Pinned to the top of this feed');
  if (post.repostedBy) {
    const when = post.repostedAt ? ` · ${post.repostedAt}` : '';
    lines.push(`🔁 Reposted by ${actorLabel(post.repostedBy)} \`${post.repostedBy.did}\`${when}`);
  }
  lines.push(`### ${headingPrefix}${actorLabel(post.author)}`);
  lines.push(`**AT-URI:** \`${post.uri}\` | **CID:** \`${post.cid}\``);
  lines.push(
    `**Author DID:** \`${post.author.did}\`${verificationSuffix(post.author.verification)}`,
  );
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
  return closeQuotes(lines);
}

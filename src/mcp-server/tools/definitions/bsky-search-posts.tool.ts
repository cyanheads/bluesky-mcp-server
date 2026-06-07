/**
 * @fileoverview Full-text search across public Bluesky posts.
 * @module mcp-server/tools/definitions/bsky-search-posts
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

/** Embed uses passthrough to flow all sub-fields through structuredContent while format() renders the key data. */
const EmbedSchema = z
  .object({})
  .passthrough()
  .describe(
    'Media or link embed attached to this post. ' +
      'type: "images" | "external" | "record" | "video" | "unknown". ' +
      'images: array of { url, alt, aspectRatio? }. ' +
      'external: { uri, title, description, thumb? }. ' +
      'record: { uri, cid, text?, authorHandle? }. ' +
      'video: { playlist?, thumbnail?, presentation?, aspectRatio? }. ' +
      'unknown: { raw }.',
  );

const PostSchema = z
  .object({
    uri: z
      .string()
      .describe(
        'AT-URI of this post (format: at://did:plc:<id>/app.bsky.feed.post/<rkey>). ' +
          'Pass to bsky_get_post_thread to read the full conversation.',
      ),
    cid: z.string().describe('Content Identifier (CID) of the post record.'),
    text: z.string().describe('Full text content of the post.'),
    author: z
      .object({
        did: z
          .string()
          .describe('Permanent DID of the author, e.g. "did:plc:z72i7hdynmk6r22z27h6tvur".'),
        handle: z
          .string()
          .describe('Human-readable handle of the author, e.g. "alice.bsky.social".'),
        displayName: z.string().optional().describe('Display name set by the author.'),
        avatar: z.string().optional().describe('URL of the author avatar image.'),
      })
      .describe('Author of this post.'),
    replyCount: z.number().optional().describe('Number of replies.'),
    repostCount: z.number().optional().describe('Number of reposts.'),
    likeCount: z.number().optional().describe('Number of likes.'),
    quoteCount: z.number().optional().describe('Number of quote posts.'),
    indexedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when the AppView indexed this post.'),
    createdAt: z.string().optional().describe('ISO 8601 timestamp when the post was created.'),
    labels: z
      .array(
        z
          .object({
            val: z
              .string()
              .describe('Label value (content warning or moderation tag, e.g. "porn", "spam").'),
          })
          .describe('A moderation label.'),
      )
      .optional()
      .describe('Moderation labels on this post.'),
    embed: EmbedSchema.optional().describe('Media or link embed, if any.'),
    replyToUri: z.string().optional().describe('AT-URI of the parent post if this is a reply.'),
  })
  .describe('A single post matching the search query.');

export const bskySearchPosts = tool('bsky_search_posts', {
  title: 'Search Bluesky Posts',
  description:
    'Full-text search across public Bluesky posts. Filters by author (handle or DID), language ' +
    '(BCP-47 code, e.g. "en"), hashtag (without the # prefix), date range (ISO 8601), and sort order. ' +
    'Returns posts with text, author info, engagement counts (likes/reposts/replies), normalized embeds, ' +
    'AT-URIs for thread drilling, and hitsTotal when the API reports the total number of matching posts. ' +
    'This is the primary entry point for social listening — pass any AT-URI from results to ' +
    'bsky_get_post_thread to read the full conversation.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .max(500)
      .describe('Full-text search query, e.g. "climate change" or "#ai announcement".'),
    author_handle: z
      .string()
      .max(253)
      .optional()
      .describe(
        'Filter to posts by this author. Accepts handle (e.g. "bsky.app") or DID. ' +
          'Use bsky_get_profile to resolve a name to a handle first.',
      ),
    language: z
      .string()
      .max(10)
      .optional()
      .describe('BCP-47 language code to restrict results to, e.g. "en", "ja", "es".'),
    tag: z
      .string()
      .max(100)
      .optional()
      .describe('Hashtag to filter by — provide without the # prefix, e.g. "ai" not "#ai".'),
    since: z
      .string()
      .max(32)
      .optional()
      .describe(
        'Return posts after this ISO 8601 datetime (inclusive), e.g. "2025-01-01T00:00:00Z".',
      ),
    until: z
      .string()
      .max(32)
      .optional()
      .describe(
        'Return posts before this ISO 8601 datetime (inclusive), e.g. "2025-12-31T23:59:59Z".',
      ),
    sort: z
      .enum(['top', 'latest'])
      .default('latest')
      .describe(
        '"latest" returns posts in reverse-chronological order (default). ' +
          '"top" returns by engagement score.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum posts to return (1–100). Default 25.'),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response. ' +
          'Note: the public Bluesky AppView restricts cursor-based search pagination for unauthenticated ' +
          'requests — passing a cursor may return a 403 error. Cursor pagination is reliable only for ' +
          'bsky_get_author_feed and bsky_get_follows.',
      ),
  }),
  output: z.object({
    posts: z.array(PostSchema).describe('Posts matching the search query.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque cursor returned by the API. ' +
          'Unreliable for unauthenticated search requests on the public AppView — ' +
          'passing it on a subsequent call may return a 403 error.',
      ),
    hitsTotal: z
      .number()
      .optional()
      .describe(
        'Total number of posts matching this query across all pages, when reported by the API. ' +
          'Use to communicate result scale without fetching every page.',
      ),
  }),

  enrichment: {
    totalReturned: z.number().describe('Number of posts in this response page.'),
    notice: z.string().optional().describe('Guidance when the result set is empty or constrained.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Searching Bluesky posts', {
      query: input.query,
      sort: input.sort,
      limit: input.limit,
    });
    const result = await getBlueskyService().searchPosts(
      {
        q: input.query,
        ...(input.author_handle ? { author: input.author_handle } : {}),
        ...(input.language ? { lang: input.language } : {}),
        ...(input.tag ? { tag: input.tag } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.until ? { until: input.until } : {}),
        sort: input.sort,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      ctx,
    );
    ctx.enrich({ totalReturned: result.posts.length });
    if (result.posts.length === 0) {
      ctx.enrich.notice(
        `No posts matched "${input.query}". Try broader terms, different spelling, or remove filters.`,
      );
    }
    return {
      posts: result.posts,
      ...(result.cursor ? { cursor: result.cursor } : {}),
      ...(result.hitsTotal != null ? { hitsTotal: result.hitsTotal } : {}),
    };
  },

  format: (result) => {
    if (result.posts.length === 0) {
      return [{ type: 'text', text: 'No posts matched this query.' }];
    }
    const header: string[] = [];
    if (result.hitsTotal != null)
      header.push(
        `**${result.hitsTotal.toLocaleString()} total matches** (showing ${result.posts.length})`,
      );
    const lines = result.posts.map((p) => {
      const parts: string[] = [];
      const author = p.author.displayName
        ? `${p.author.displayName} (@${p.author.handle})`
        : `@${p.author.handle}`;
      parts.push(`### ${author}`);
      parts.push(`**AT-URI:** \`${p.uri}\` | **CID:** \`${p.cid}\``);
      parts.push(`**Author DID:** \`${p.author.did}\``);
      parts.push(p.text);
      const meta: string[] = [];
      if (p.likeCount != null) meta.push(`${p.likeCount} likes`);
      if (p.repostCount != null) meta.push(`${p.repostCount} reposts`);
      if (p.replyCount != null) meta.push(`${p.replyCount} replies`);
      if (p.quoteCount != null) meta.push(`${p.quoteCount} quotes`);
      if (meta.length) parts.push(`*${meta.join(' · ')}*`);
      if (p.createdAt) parts.push(`*Created: ${p.createdAt}*`);
      if (p.indexedAt) parts.push(`*Indexed: ${p.indexedAt}*`);
      if (p.embed) {
        const embed = p.embed as Record<string, unknown>;
        const embedType = embed.type as string | undefined;
        if (embedType === 'images') {
          const images = embed.images as Array<{ url: string; alt: string }> | undefined;
          if (images?.length) {
            parts.push(
              `📷 ${images.length} image(s): ${images.map((img) => `${img.url} [${img.alt}]`).join(', ')}`,
            );
          }
        } else if (embedType === 'external') {
          parts.push(`🔗 [${embed.title}](${embed.uri}): ${embed.description}`);
        } else if (embedType === 'record') {
          parts.push(`💬 Quoted: \`${embed.uri}\``);
          if (embed.text) parts.push(`   > ${embed.text}`);
        } else if (embedType === 'video') {
          const vid = embed as { thumbnail?: string; playlist?: string; presentation?: string };
          const label = vid.presentation === 'gif' ? '🎞 GIF' : '🎬 Video';
          if (vid.thumbnail) parts.push(`${label}: ${vid.thumbnail}`);
          else parts.push(label);
        }
      }
      if (p.replyToUri) parts.push(`↩ Reply to \`${p.replyToUri}\``);
      if (p.author.avatar) parts.push(`**Avatar:** ${p.author.avatar}`);
      if (p.labels?.length) parts.push(`**Labels:** ${p.labels.map((l) => l.val).join(', ')}`);
      return parts.join('\n');
    });
    const body = lines.join('\n\n---\n\n');
    const footer = result.cursor ? `\n\n---\n*cursor: \`${result.cursor}\`*` : '';
    return [
      { type: 'text', text: (header.length ? `${header.join('\n')}\n\n` : '') + body + footer },
    ];
  },
});

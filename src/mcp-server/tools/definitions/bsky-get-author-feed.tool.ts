/**
 * @fileoverview Get a Bluesky user's recent posts ordered newest-first.
 * @module mcp-server/tools/definitions/bsky-get-author-feed
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { AuthorFeedResult } from '@/services/bluesky/types.js';

/** Embed uses passthrough so all sub-fields flow through structuredContent while format() renders the key data. */
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
        'AT-URI of the post, e.g. "at://did:plc:xxx/app.bsky.feed.post/yyy". Use with bsky_get_post_thread.',
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
    replyCount: z.number().optional().describe('Number of replies to this post.'),
    repostCount: z.number().optional().describe('Number of reposts.'),
    likeCount: z.number().optional().describe('Number of likes.'),
    quoteCount: z.number().optional().describe('Number of quote posts.'),
    indexedAt: z.string().optional().describe('ISO 8601 timestamp when this post was indexed.'),
    createdAt: z.string().optional().describe('ISO 8601 timestamp when this post was created.'),
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
    embed: EmbedSchema.optional().describe('Media or link embed attached to this post, if any.'),
    replyToUri: z
      .string()
      .optional()
      .describe('AT-URI of the post this is a reply to, if applicable.'),
  })
  .describe('A single post from the author feed.');

export const bskyGetAuthorFeed = tool('bsky_get_author_feed', {
  title: 'Get Bluesky Author Feed',
  description:
    "Get a Bluesky user's recent posts ordered newest-first. Filter by post type: " +
    '"posts_with_replies" (everything), "posts_no_replies" (original posts only), ' +
    '"posts_with_media" (posts with images or links), or "posts_and_author_threads" ' +
    '(posts the author started). Returns posts with full text, engagement counts, embeds, ' +
    'and AT-URIs for drilling into threads via bsky_get_post_thread. Supports cursor pagination.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    actor: z
      .string()
      .max(253)
      .describe('Handle (e.g. "alice.bsky.social") or DID of the author whose feed to fetch.'),
    filter: z
      .enum([
        'posts_with_replies',
        'posts_no_replies',
        'posts_with_media',
        'posts_and_author_threads',
      ])
      .default('posts_no_replies')
      .describe(
        'Filter for post types: "posts_no_replies" for original posts only, "posts_with_replies" for everything, ' +
          '"posts_with_media" for posts with images/links, "posts_and_author_threads" for threads the author started.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of posts to return (1–100). Default 25.'),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe('Opaque pagination cursor from a previous response. Omit for the first page.'),
  }),
  output: z.object({
    posts: z.array(PostSchema).describe('Posts from this author, ordered newest-first.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor for the next page. Absent on the last page.'),
  }),

  errors: [
    {
      reason: 'actor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The actor handle or DID does not resolve to an existing account.',
      recovery: 'Verify the handle or DID, or use bsky_search_actors to find the correct actor.',
    },
  ],

  enrichment: {
    totalReturned: z.number().describe('Number of posts in this response page.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Fetching Bluesky author feed', {
      actor: input.actor,
      filter: input.filter,
      limit: input.limit,
    });
    let result: AuthorFeedResult;
    try {
      result = await getBlueskyService().getAuthorFeed(
        {
          actor: input.actor,
          filter: input.filter,
          limit: input.limit,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const body = (err.data as { responseBody?: string } | undefined)?.responseBody ?? '';
        if (
          err.data &&
          (body.includes('not found') || body.includes('Not Found') || body.includes('NotFound'))
        ) {
          throw ctx.fail(
            'actor_not_found',
            `Actor not found: "${input.actor}"`,
            ctx.recoveryFor('actor_not_found'),
          );
        }
      }
      throw err;
    }
    ctx.enrich({ totalReturned: result.feed.length });
    if (result.feed.length === 0) {
      ctx.enrich.notice(`No posts found for actor "${input.actor}" with filter "${input.filter}".`);
    }
    return { posts: result.feed, ...(result.cursor ? { cursor: result.cursor } : {}) };
  },

  format: (result) => {
    if (result.posts.length === 0) {
      return [{ type: 'text', text: 'No posts found for this actor.' }];
    }
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
          parts.push(`💬 Quoted post AT-URI: \`${embed.uri}\``);
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
    const output = lines.join('\n\n---\n\n');
    return [
      {
        type: 'text',
        text: result.cursor ? `${output}\n\n---\n*cursor: \`${result.cursor}\`*` : output,
      },
    ];
  },
});

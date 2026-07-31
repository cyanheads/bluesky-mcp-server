/**
 * @fileoverview Get a Bluesky user's recent feed — their own posts and their reposts, newest-first.
 * No upstream filter excludes reposts, so `limit` counts both; the enrichment reports the split
 * rather than leaving a caller after the actor's own writing to page blind for it.
 * @module mcp-server/tools/definitions/bsky-get-author-feed
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { renderPostLines } from '@/mcp-server/tools/post-format.js';
import { AT_IDENTIFIER_MESSAGE, AT_IDENTIFIER_REGEX } from '@/services/bluesky/at-syntax.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { AuthorFeedResult } from '@/services/bluesky/types.js';

/**
 * Embed uses passthrough so the normalized union flows through structuredContent whole; the fields
 * it names are the fields renderEmbedLines() emits, so both channels carry the same embed. The
 * linter cannot walk past a passthrough, so this list and that renderer are kept in step by hand.
 */
const EmbedSchema = z
  .object({})
  .passthrough()
  .describe(
    'Media or link embed attached to this post. ' +
      'type: "images" | "external" | "record" | "video" | "unknown". ' +
      'images: array of { url, alt } — also carries app.bsky.embed.gallery embeds. ' +
      'external: { uri, title, description }. ' +
      'record: { uri, cid, text?, authorHandle?, embeds?, media?, omittedEmbeds?, recordKind? } — embeds is the ' +
      "quoted post's own attachments, so a quote of an image post carries those images here; media is the " +
      'image/video/link attached alongside the quote by the post doing the quoting, on a recordWithMedia ' +
      'embed. Both are embeds of these same shapes. Bluesky fills embeds for the post being quoted and no ' +
      'deeper, so a quote nested inside another quote ordinarily carries none; omittedEmbeds counts any it ' +
      'did carry that were past the nesting this server follows, so an unattached quote and one whose ' +
      'attachments are missing are never the same value. Fetch the quote uri as its own post to read them. ' +
      'recordKind is absent for an ordinary quoted post and otherwise names what stood in for one: ' +
      '"notFound" | "blocked" | "detached" (the quote exists but cannot be read) or ' +
      '"generator" | "list" | "starterPack" | "labeler" | "unknown" (the quoted record is not a post). ' +
      'When recordKind is set, text and authorHandle are absent because that variant does not carry them — ' +
      'do not read the quote as an empty post. ' +
      'video: { playlist?, thumbnail?, presentation? }. ' +
      'unknown: { raw } — raw is the upstream $type this server has no mapping for.',
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
            src: z
              .string()
              .optional()
              .describe(
                'DID of the labeler that applied this label. Equal to the post author DID when the ' +
                  'account labelled its own post, and a labeler service DID otherwise.',
              ),
            cts: z.string().optional().describe('ISO 8601 timestamp when the label was applied.'),
          })
          .describe('A moderation label applied by the AppView or a labeler service.'),
      )
      .optional()
      .describe('Moderation labels on this post.'),
    embed: EmbedSchema.optional(),
    replyToUri: z
      .string()
      .optional()
      .describe('AT-URI of the post this is a reply to, if applicable.'),
    replyRootUri: z
      .string()
      .optional()
      .describe(
        'AT-URI of the post this conversation started from, if this is a reply. ' +
          'Pass to bsky_get_post_thread to read the whole conversation rather than one branch.',
      ),
    repostedBy: z
      .object({
        did: z.string().describe('Permanent DID of the account that reposted.'),
        handle: z.string().describe('Handle of the account that reposted.'),
        displayName: z.string().optional().describe('Display name of the account that reposted.'),
      })
      .optional()
      .describe(
        'Present only when this item is a repost rather than the requested actor writing. ' +
          'The post itself — text, author, engagement counts — belongs to the author field, not to this account.',
      ),
    repostedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of the repost. Present only on reposted items.'),
  })
  .describe("A single item from the author feed — the actor's own post, or a post they reposted.");

export const bskyGetAuthorFeed = tool('bsky_get_author_feed', {
  title: 'Get Bluesky Author Feed',
  description:
    "Get a Bluesky user's recent feed ordered newest-first. Every filter includes reposts, so " +
    'items authored by other accounts appear alongside the actor\'s own writing — a "repostedBy" ' +
    'field marks those, and the "author" field always names who actually wrote the post. Filter by ' +
    'post type: "posts_with_replies" (everything), "posts_no_replies" (excludes replies), ' +
    '"posts_with_media" (posts with images or links), or "posts_and_author_threads" ' +
    '(posts the author started). Returns posts with full text, engagement counts, embeds, ' +
    'and AT-URIs for drilling into threads via bsky_get_post_thread. Because "limit" counts reposts ' +
    "too, a page from an account that reposts heavily holds far fewer of that account's own posts " +
    'than the limit suggests; the enrichment fields report the split, so read "originalPosts" rather ' +
    "than the limit when you want the actor's own writing. Supports cursor pagination.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    actor: z
      .string()
      .min(1)
      .max(253)
      .regex(AT_IDENTIFIER_REGEX, AT_IDENTIFIER_MESSAGE)
      .describe(
        'Handle (e.g. "alice.bsky.social") or DID of the author whose feed to fetch. ' +
          'A bare name without a dot is not a handle — use bsky_search_actors to resolve one.',
      ),
    filter: z
      .enum([
        'posts_with_replies',
        'posts_no_replies',
        'posts_with_media',
        'posts_and_author_threads',
      ])
      .default('posts_no_replies')
      .describe(
        'Filter for post types: "posts_no_replies" excludes replies, "posts_with_replies" for everything, ' +
          '"posts_with_media" for posts with images/links, "posts_and_author_threads" for threads the author started. ' +
          'None of these exclude reposts — the AppView offers no repost filter, so check "repostedBy" on each item.',
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
    posts: z
      .array(PostSchema)
      .describe(
        "Feed items, newest-first — the actor's own posts and the posts they reposted. Items carrying " +
          '"repostedBy" were written by the account named in "author", not by the requested actor.',
      ),
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
    originalPosts: z
      .number()
      .optional()
      .describe(
        'How many items on this page the requested actor wrote. Present whenever the page carries ' +
          "at least one repost — the number a caller asking for the actor's own writing is after, " +
          'since "limit" counts reposts too and no filter excludes them.',
      ),
    reposts: z
      .number()
      .optional()
      .describe(
        'How many items on this page are posts the requested actor reposted rather than wrote. ' +
          'Present only when there is at least one; these items carry "repostedBy".',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when more posts exist beyond this page (a cursor was returned).'),
    shown: z.number().optional().describe('Number of posts returned on this page.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
    notice: z.string().optional().describe('Guidance when the result set is empty or constrained.'),
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
    /**
     * The split is what a caller after the actor's own writing actually asked for, and it costs no
     * second request — every item already carries its repost marker. Reported only when a repost is
     * present: on a page that is entirely original posts, `totalReturned` already says it, and a
     * pair of numbers that never varies carries no information.
     */
    const reposts = result.feed.filter((post) => post.repostedBy).length;
    if (reposts > 0) {
      ctx.enrich({ originalPosts: result.feed.length - reposts, reposts });
    }
    if (result.cursor) {
      ctx.enrich.truncated({
        shown: result.feed.length,
        cap: input.limit,
        guidance: 'More posts exist — pass the returned cursor to fetch the next page.',
      });
    }
    if (result.feed.length === 0) {
      ctx.enrich.notice(`No posts found for actor "${input.actor}" with filter "${input.filter}".`);
    }
    return { posts: result.feed, ...(result.cursor ? { cursor: result.cursor } : {}) };
  },

  format: (result) => {
    if (result.posts.length === 0) {
      return [{ type: 'text', text: 'No posts found for this actor.' }];
    }
    const output = result.posts.map((p) => renderPostLines(p).join('\n')).join('\n\n---\n\n');
    return [
      {
        type: 'text',
        text: result.cursor ? `${output}\n\n---\n*cursor: \`${result.cursor}\`*` : output,
      },
    ];
  },
});

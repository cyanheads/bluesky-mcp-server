/**
 * @fileoverview Read the posts a Bluesky feed generator serves — a trend's feed, a custom feed such
 * as Discover, or a feed quoted in a post — by AT-URI or bsky.app URL, without credentials.
 * @module mcp-server/tools/definitions/bsky-get-feed
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderPostLines } from '@/mcp-server/tools/post-format.js';
import { FEED_REF_MESSAGE, FEED_REF_REGEX } from '@/services/bluesky/at-syntax.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

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
      "quoted post's own attachments; media is the image/video/link attached alongside the quote by the post " +
      'doing the quoting, on a recordWithMedia embed. Both are embeds of these same shapes. omittedEmbeds counts ' +
      'attachments past the nesting this server follows — fetch the quote uri as its own post to read them. ' +
      'recordKind is absent for an ordinary quoted post and otherwise names what stood in for one: ' +
      '"notFound" | "blocked" | "detached" (the quote exists but cannot be read) or ' +
      '"generator" | "list" | "starterPack" | "labeler" | "unknown" (the quoted record is not a post). ' +
      'A "generator" quote is a feed: pass its uri to bsky_get_feed to read it. ' +
      'When recordKind is set, text and authorHandle are absent because that variant does not carry them. ' +
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
    pinned: z
      .boolean()
      .optional()
      .describe(
        'True when the feed pinned this post to its top. A pin is placement, not recency — the post ' +
          'is often older than the items below it. Absent on every other item.',
      ),
    repostedBy: z
      .object({
        did: z.string().describe('Permanent DID of the account that reposted.'),
        handle: z.string().describe('Handle of the account that reposted.'),
        displayName: z.string().optional().describe('Display name of the account that reposted.'),
      })
      .optional()
      .describe(
        'Present only when the feed served this item as a repost. The post itself — text, author, ' +
          'engagement counts — belongs to the author field, not to this account.',
      ),
    repostedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp of the repost. Present only on reposted items.'),
  })
  .describe('A single post the feed served.');

export const bskyGetFeed = tool('bsky_get_feed', {
  title: 'Get Bluesky Feed',
  description:
    'Read the posts a Bluesky feed generator serves, in the order the feed ranks them. Accepts the ' +
    "feed's AT-URI (at://<handle-or-did>/app.bsky.feed.generator/<rkey>) or its bsky.app page " +
    '(https://bsky.app/profile/<handle-or-did>/feed/<rkey>). Feeds come from the "feedUri" of each ' +
    'bsky_get_trending topic — the way to read what a trend is about — from a quoted feed in a post ' +
    '(an embed with recordKind "generator"), or from a shared link; Discover is ' +
    'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot. Returns posts with full ' +
    'text, engagement counts, embeds, and AT-URIs for drilling into threads via bsky_get_post_thread. ' +
    'A post the feed pinned to its top carries "pinned: true"; a repost carries "repostedBy". ' +
    'Personalized feeds, which Bluesky serves only to a signed-in account, cannot be read here. ' +
    'Supports cursor pagination.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    feed: z
      .string()
      .max(2048)
      .regex(FEED_REF_REGEX, FEED_REF_MESSAGE)
      .describe(
        'The feed to read — its AT-URI, e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot", ' +
          'or its bsky.app URL, e.g. "https://bsky.app/profile/bsky.app/feed/whats-hot". The owner may be a ' +
          'handle or a DID; a handle costs one extra lookup. A trend\'s "feedUri" works as-is.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Maximum number of posts to return (1–100). Default 25. A feed may return fewer than the ' +
          'limit on a page that still has more after it — follow the cursor, not the count.',
      ),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response of the same feed. Omit for the first page.',
      ),
  }),
  output: z.object({
    posts: z.array(PostSchema).describe('Posts the feed served, in the order it ranked them.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor for the next page. Absent when the feed has nothing further.'),
  }),

  enrichment: {
    totalReturned: z.number().describe('Number of posts in this response page.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the feed has more posts after this page (a cursor was returned).'),
    shown: z.number().optional().describe('Number of posts returned on this page.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
    notice: z.string().optional().describe('Guidance when the feed returned nothing.'),
  },

  errors: [
    {
      reason: 'feed_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No feed generator exists at that address, or the handle in it does not resolve to an account.',
      recovery:
        'Check the feed address, or take a working feedUri from bsky_get_trending, whose trends each carry one.',
      thrownBy: 'service',
    },
    {
      reason: 'feed_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The feed exists but the service that generates it did not answer — offline, misconfigured, or erroring.',
      recovery:
        "This feed is down on its operator's side; try again later, or read a different feed such as a bsky_get_trending feedUri.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'feed_requires_login',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'The feed is personalized and Bluesky serves it only to a signed-in account.',
      recovery:
        'Personalized feeds cannot be read here; read a public feed instead, such as a bsky_get_trending feedUri or Discover.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching Bluesky feed', { feed: input.feed, limit: input.limit });
    const result = await getBlueskyService().getFeed(
      {
        feed: input.feed,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      ctx,
    );
    ctx.enrich({ totalReturned: result.posts.length });
    /**
     * The cursor is the only sound signal. A trend feed answers 29 of a requested 30 with more
     * pages behind it, and a personalized feed answers a single item with `cursor: ""` — the count
     * alone would call the first complete and the second truncated. An empty cursor never reaches
     * here: the service drops it.
     */
    if (result.cursor) {
      ctx.enrich.truncated({
        shown: result.posts.length,
        cap: input.limit,
        guidance: 'More posts exist — pass the returned cursor to fetch the next page.',
      });
    }
    if (result.posts.length === 0) {
      ctx.enrich.notice(
        'The feed returned no posts. It may have nothing to serve right now — try a different feed, such as a bsky_get_trending feedUri.',
      );
    }
    return { posts: result.posts, ...(result.cursor ? { cursor: result.cursor } : {}) };
  },

  format: (result) => {
    if (result.posts.length === 0) {
      return [{ type: 'text', text: 'The feed returned no posts.' }];
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

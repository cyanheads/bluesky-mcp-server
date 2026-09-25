/**
 * @fileoverview Get a Bluesky user's recent feed — their own posts and their reposts, newest-first,
 * with the profile's pinned post on request. Only the two media filters leave reposts out, so under
 * the other three `limit` counts both; the enrichment reports the split rather than leaving a caller
 * after the actor's own writing to page blind for it.
 * @module mcp-server/tools/definitions/bsky-get-author-feed
 */

import { type ContentBlock, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { renderPostLines } from '@/mcp-server/tools/post-format.js';
import { pageEnrichment, respondWithinBudget } from '@/mcp-server/tools/response-budget.js';
import { ACTOR_REF_MESSAGE, ACTOR_REF_REGEX, actorFromRef } from '@/services/bluesky/at-syntax.js';
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
      'A "generator" quote is a feed: pass its uri to bsky_get_feed to read it. ' +
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
        verification: z
          .object({
            verifiedStatus: z
              .string()
              .describe(
                'Whether a trusted verifier verified the author: "valid", "invalid" (verified once, no ' +
                  'longer holds), or "none". Passed through as Bluesky sends it, so another value may appear.',
              ),
            trustedVerifierStatus: z
              .string()
              .describe(
                'Whether the author is itself a trusted verifier — same values as verifiedStatus.',
              ),
          })
          .optional()
          .describe(
            'Bluesky verification of the author — what tells a verified account from a look-alike ' +
              'handle. Absent when Bluesky sent none. Who issued it is on bsky_get_profile.',
          ),
      })
      .describe('Author of this post.'),
    replyCount: z.number().optional().describe('Number of replies to this post.'),
    repostCount: z.number().optional().describe('Number of reposts.'),
    likeCount: z.number().optional().describe('Number of likes.'),
    quoteCount: z
      .number()
      .optional()
      .describe(
        'Number of quote posts Bluesky counts — read them with bsky_get_post_quotes. An upper bound on ' +
          'what that returns, since the counter keeps quotes that have left the index.',
      ),
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
        'True on the post the actor pinned to their profile, returned when include_pins is set. A pin is ' +
          'placement, not recency — the post is often older than the items below it. Absent on every other item.',
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

const AuthorFeedOutput = z.object({
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
});

/** Module-level so the handler can measure the rendered page against the response budget. */
function formatAuthorFeed(result: z.infer<typeof AuthorFeedOutput>): ContentBlock[] {
  if (result.posts.length === 0 && !result.cursor) {
    return [{ type: 'text', text: 'No posts found for this actor.' }];
  }
  const output = result.posts.length
    ? result.posts.map((p) => renderPostLines(p).join('\n')).join('\n\n---\n\n')
    : 'No posts on this page.';
  return [
    {
      type: 'text',
      text: result.cursor ? `${output}\n\n---\n*cursor: \`${result.cursor}\`*` : output,
    },
  ];
}

export const bskyGetAuthorFeed = tool('bsky_get_author_feed', {
  title: 'Get Bluesky Author Feed',
  description:
    "Get a Bluesky user's recent feed ordered newest-first. Filter by post type: " +
    '"posts_with_replies" (everything), "posts_no_replies" (excludes replies), "posts_and_author_threads" ' +
    '(posts the author started), "posts_with_media" (the actor\'s own posts with images or video — no ' +
    'link cards), or "posts_with_video" (the actor\'s own video posts). The first three include reposts, ' +
    'so items authored by other accounts appear alongside the actor\'s own writing — a "repostedBy" ' +
    'field marks those, and the "author" field always names who actually wrote the post; the two media ' +
    'filters return no reposts. Set include_pins to also get the post pinned to the profile, marked ' +
    '"pinned", first on the first page — in addition to "limit", and whether or not it matches the ' +
    'filter. Returns posts with full text, engagement counts, embeds, and AT-URIs for drilling into ' +
    'threads via bsky_get_post_thread. Because "limit" counts reposts too, a page from an account that ' +
    "reposts heavily holds far fewer of that account's own posts than the limit suggests; the " +
    'enrichment fields report the split, so read "originalPosts" rather than the limit when you want ' +
    "the actor's own writing. Supports cursor pagination.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    actor: z
      .string()
      .min(1)
      .max(2048)
      .regex(ACTOR_REF_REGEX, ACTOR_REF_MESSAGE)
      .describe(
        'Handle (e.g. "alice.bsky.social") or DID of the author whose feed to fetch. A leading "@" and ' +
          'the account\'s bsky.app page ("https://bsky.app/profile/alice.bsky.social") are accepted and ' +
          'read as the handle or DID they carry. ' +
          'A bare name without a dot is not a handle — use bsky_search_actors to resolve one.',
      ),
    filter: z
      .enum([
        'posts_with_replies',
        'posts_no_replies',
        'posts_with_media',
        'posts_and_author_threads',
        'posts_with_video',
      ])
      .default('posts_no_replies')
      .describe(
        'Filter for post types: "posts_no_replies" excludes replies, "posts_with_replies" for everything, ' +
          '"posts_and_author_threads" for threads the author started — all three include reposts, so check ' +
          '"repostedBy" on each item. "posts_with_media" returns the actor\'s own posts with images or ' +
          'video, not link cards, and "posts_with_video" their video posts; neither includes reposts.',
      ),
    include_pins: z
      .boolean()
      .default(false)
      .describe(
        'Also return the post pinned to the actor\'s profile, marked "pinned: true", first on the first ' +
          'page. It arrives in addition to "limit", whether or not it matches "filter", and is not repeated ' +
          'on later pages. Default false.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Maximum number of posts to return (1–100). Default 25. A page that would pass the 48,000-byte ' +
          'response budget comes back with fewer posts and "budgetCapped: true"; its cursor continues ' +
          'from the first post it left out.',
      ),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response for the same actor, passed back unchanged. ' +
          'Omit for the first page.',
      ),
  }),
  output: AuthorFeedOutput,

  errors: [
    {
      reason: 'actor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The actor handle or DID does not resolve to an existing account.',
      recovery: 'Verify the handle or DID, or use bsky_search_actors to find the correct actor.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Bluesky could not continue from the cursor the request carried — it answers a cursor it cannot decode with HTTP 500.',
      recovery:
        'Drop the cursor to start again from the first page, or pass the cursor exactly as the previous response for this same actor returned it.',
      thrownBy: 'service',
    },
  ],

  enrichment: {
    totalReturned: z.number().describe('Number of posts in this response page.'),
    originalPosts: z
      .number()
      .optional()
      .describe(
        'How many items on this page the requested actor wrote, a pinned post included. Present whenever ' +
          "the page carries at least one repost — the number a caller asking for the actor's own writing " +
          'is after, since under the filters that include reposts "limit" counts them too.',
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
    budgetCapped: z
      .boolean()
      .optional()
      .describe(
        "True when a page of the requested limit would have passed this server's 48,000-byte response " +
          'budget, so Bluesky was asked again for fewer posts and that page was returned whole. The ' +
          'cursor comes from that same response, so paging on from it skips nothing. Independent of ' +
          '"truncated", which still means only that a cursor was returned.',
      ),
    notice: z.string().optional().describe('Guidance when the result set is empty or constrained.'),
  },

  async handler(input, ctx) {
    const actor = actorFromRef(input.actor);
    ctx.log.info('Fetching Bluesky author feed', {
      actor,
      filter: input.filter,
      includePins: input.include_pins,
      limit: input.limit,
    });
    /** `cursorAccepted` on a re-request: Bluesky just answered this cursor, so a 500 is not about it. */
    const fetchPage = async (limit: number, cursorAccepted = false): Promise<AuthorFeedResult> => {
      try {
        return await getBlueskyService().getAuthorFeed(
          {
            actor,
            filter: input.filter,
            includePins: input.include_pins,
            limit,
            ...(input.cursor ? { cursor: input.cursor, cursorAccepted } : {}),
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
              `Actor not found: "${actor}"`,
              ctx.recoveryFor('actor_not_found'),
            );
          }
        }
        throw err;
      }
    };

    return respondWithinBudget(ctx, await fetchPage(input.limit), {
      count: (page) => page.feed.length,
      limit: input.limit,
      /** A profile's pinned post arrives in addition to `limit`, so it is not counted toward one. */
      limitFor: (page, kept) =>
        kept - page.feed.slice(0, kept).filter((post) => post.pinned).length,
      slice: (page, kept) => ({ ...page, feed: page.feed.slice(0, kept) }),
      refetch: (limit) => fetchPage(limit, true),
      respond: (page, requested) => {
        /**
         * The split is what a caller after the actor's own writing actually asked for, and it costs
         * no second request — every item already carries its repost marker. Reported only when a
         * repost is present: on a page that is entirely original posts, `totalReturned` already
         * says it, and a pair of numbers that never varies carries no information.
         */
        const reposts = page.feed.filter((post) => post.repostedBy).length;
        return {
          output: { posts: page.feed, ...(page.cursor ? { cursor: page.cursor } : {}) },
          enrichment: pageEnrichment({
            shown: page.feed.length,
            cursor: page.cursor,
            limit: input.limit,
            requested,
            noun: 'posts',
            more: 'More posts exist — pass the returned cursor to fetch the next page.',
            empty: `No posts found for actor "${actor}" with filter "${input.filter}".`,
            ...(reposts > 0
              ? { extra: { originalPosts: page.feed.length - reposts, reposts } }
              : {}),
          }),
        };
      },
      schema: AuthorFeedOutput,
      format: formatAuthorFeed,
    });
  },

  format: formatAuthorFeed,
});

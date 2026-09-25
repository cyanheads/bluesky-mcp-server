/**
 * @fileoverview Read the quote posts behind a Bluesky post's quoteCount — newest first, without
 * credentials. Every result quotes the same post, so each result's embed is cut back to the address
 * of that post and the media the quoting post attached; the queried post itself is not restated.
 * @module mcp-server/tools/definitions/bsky-get-post-quotes
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { renderPostLines } from '@/mcp-server/tools/post-format.js';
import {
  atUriFromRef,
  POST_URI_REF_MESSAGE,
  POST_URI_REF_REGEX,
} from '@/services/bluesky/at-syntax.js';
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
    'The embed on this quote post. On every result it is a "record" embed pointing at the queried post, ' +
      'cut back to what the quoting post itself carries: { uri, cid, recordKind?, media? } — uri and cid ' +
      'address the queried post (the revision this quote points at), recordKind is set only when that ' +
      'post is unreadable ("notFound" | "blocked" | "detached"), and media is the image/video/link the ' +
      "quoting post attached alongside the quote. The queried post's own text, author, and attachments " +
      'are not restated on each result. Other shapes, should an embed point elsewhere: images: ' +
      '{ images: [{ url, alt }] }; external: { uri, title, description }; record: { uri, cid, text?, ' +
      'authorHandle?, embeds?, media?, omittedEmbeds?, recordKind? }; video: { playlist?, thumbnail?, ' +
      'presentation? }; unknown: { raw }.',
  );

const PostSchema = z
  .object({
    uri: z
      .string()
      .describe(
        'AT-URI of the quote post, e.g. "at://did:plc:xxx/app.bsky.feed.post/yyy". Pass to ' +
          'bsky_get_post_thread for the replies to it, or back to this tool for its own quotes.',
      ),
    cid: z.string().describe('Content Identifier (CID) of the quote post record.'),
    text: z.string().describe('Full text of the quote post — the commentary on the queried post.'),
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
      .describe('Author of this quote post.'),
    replyCount: z.number().optional().describe('Number of replies to this quote post.'),
    repostCount: z.number().optional().describe('Number of reposts.'),
    likeCount: z.number().optional().describe('Number of likes.'),
    quoteCount: z
      .number()
      .optional()
      .describe(
        'Number of quote posts Bluesky counts for this quote post — read them with this tool. An upper ' +
          'bound on what it returns, since the counter keeps quotes that have left the index.',
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
      .describe('AT-URI of the post this quote post replies to, if it is also a reply.'),
    replyRootUri: z
      .string()
      .optional()
      .describe(
        'AT-URI of the post the conversation it replies in started from, if it is also a reply.',
      ),
  })
  .describe('A post quoting the queried post.');

export const bskyGetPostQuotes = tool('bsky_get_post_quotes', {
  title: 'Get Bluesky Post Quotes',
  description:
    'Read the quote posts behind a Bluesky post\'s "quoteCount" — the posts that embed it with ' +
    'commentary of their own, newest first. On Bluesky this is where much of the reaction to a post ' +
    "lives; bsky_get_post_thread returns replies only. Accepts the post's AT-URI " +
    '(at://<handle-or-did>/app.bsky.feed.post/<rkey>) from the "uri" field of any returned post, or its ' +
    'bsky.app URL (https://bsky.app/profile/<handle-or-did>/post/<rkey>); a handle costs one extra ' +
    'lookup. Returns each quote post with full text, author, engagement counts, and AT-URI. Each ' +
    "result's embed names the queried post by AT-URI and CID only — its text is not repeated on every " +
    'result — and keeps any media the quoting post attached. "quoteCount" is an upper bound on what ' +
    "this returns: Bluesky's counter keeps quotes that have left the index. Supports cursor pagination.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    uri: z
      .string()
      .max(2048)
      .regex(POST_URI_REF_REGEX, POST_URI_REF_MESSAGE)
      .describe(
        'The post whose quotes to read — its AT-URI, e.g. ' +
          '"at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l", or its bsky.app URL, e.g. ' +
          '"https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l"; a trailing "/", "?…", or "#…" on the URL is ' +
          'ignored. Posts only — a feed, profile, or list address is rejected.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe(
        'Maximum number of quote posts to return (1–100). Default 25. Pages often hold fewer than the ' +
          'limit and still continue — follow the cursor, not the count.',
      ),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response for the same post, passed back unchanged. ' +
          'Omit for the first page.',
      ),
  }),
  output: z.object({
    uri: z
      .string()
      .describe(
        'AT-URI of the post whose quotes these are, in DID form — the form Bluesky was asked in, whatever ' +
          'form the input took.',
      ),
    posts: z.array(PostSchema).describe('Posts quoting the queried post, newest first.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor for the next page. Absent when there are no more quotes.'),
  }),

  enrichment: {
    totalReturned: z.number().describe('Number of quote posts in this response page.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when Bluesky returned a cursor, whatever this page held — pages often come back short of ' +
          'the limit with more behind them.',
      ),
    shown: z.number().optional().describe('Number of quote posts returned on this page.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on the page: that more quotes can be fetched with the returned cursor, or why the ' +
          'page is empty — the post has no readable quotes, or the last page was reached.',
      ),
  },

  errors: [
    {
      reason: 'post_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No post exists at that address, or the handle in it does not resolve to an account.',
      recovery:
        "Verify the AT-URI, or re-read the author's recent posts with bsky_get_author_feed to find the post's current AT-URI.",
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Bluesky could not continue from the cursor the request carried — it answers a cursor it cannot decode with HTTP 500.',
      recovery:
        'Drop the cursor to start again from the first page, or pass the cursor exactly as the previous response for this same post returned it.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const uri = atUriFromRef(input.uri);
    ctx.log.info('Fetching Bluesky post quotes', { uri, limit: input.limit });
    const result = await getBlueskyService().getQuotes(
      { uri, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
      ctx,
    );
    ctx.enrich({ totalReturned: result.posts.length });
    /**
     * The cursor is the only continuation signal: at limit 100, pages of 72–99 quotes carried one and
     * the last page (6) none, so page size says nothing about what is left.
     */
    if (result.cursor) {
      ctx.enrich.truncated({
        shown: result.posts.length,
        cap: input.limit,
        guidance: 'More quotes exist — pass the returned cursor to fetch the next page.',
      });
    } else if (result.posts.length === 0) {
      ctx.enrich.notice(
        input.cursor
          ? 'No more quotes — the previous page was the last.'
          : result.quoteCount
            ? `Bluesky returned no quotes of ${result.uri}, though its quoteCount is ${result.quoteCount}: the counter keeps quotes that have left the index, so none of them can be read.`
            : `${result.uri} has no quotes.`,
      );
    }
    return {
      uri: result.uri,
      posts: result.posts,
      ...(result.cursor ? { cursor: result.cursor } : {}),
    };
  },

  format: (result) => {
    const header = `## Quotes of \`${result.uri}\``;
    const footer = result.cursor ? `\n\n---\n*cursor: \`${result.cursor}\`*` : '';
    if (result.posts.length === 0) {
      return [{ type: 'text', text: `${header}\n\nNo quote posts on this page.${footer}` }];
    }
    const note =
      "*Each quote's embed names the post above by AT-URI and CID; its text is not repeated here.*";
    const body = result.posts.map((p) => renderPostLines(p).join('\n')).join('\n\n---\n\n');
    return [{ type: 'text', text: `${header}\n${note}\n\n${body}${footer}` }];
  },
});

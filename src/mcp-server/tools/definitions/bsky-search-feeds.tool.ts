/**
 * @fileoverview Keyless feed-catalog metadata search with opaque continuation and literal rendering.
 * @module mcp-server/tools/definitions/bsky-search-feeds
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { closeQuotes, destinationLink, quoteUserText } from '@/mcp-server/tools/post-format.js';
import { clampReadLimit, composeNotices, readLimitSchema } from '@/mcp-server/tools/read-limits.js';
import { NON_BLANK_MESSAGE, NON_BLANK_REGEX } from '@/services/bluesky/at-syntax.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

export const bskySearchFeeds = tool('bsky_search_feeds', {
  title: 'Search Bluesky Feeds',
  description:
    'Search metadata in the provider’s public feed catalog, without credentials. This searches feed names and descriptions, not post text, and does not enumerate every feed. Returns feeds in provider order with generator AT-URIs and creator identities; pass a feedUri to bsky_get_feed to read its posts. Uses app.bsky.unspecced.getPopularFeedGenerators, an unstable upstream API that may change or become unavailable. Continue with the returned opaque cursor and the same query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(500)
      .regex(NON_BLANK_REGEX, NON_BLANK_MESSAGE)
      .describe('Feed catalog metadata to search, e.g. "science". Must not be blank.'),
    limit: readLimitSchema(100)
      .default(25)
      .describe(
        'Maximum feeds to return. Default 25; values above 100 are clamped with a notice unless read-limit clamping is disabled.',
      ),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'Opaque cursor from a previous response to this same query. Omit for the first page.',
      ),
  }),
  output: z.object({
    feeds: z
      .array(
        z
          .object({
            feedUri: z
              .string()
              .describe('Feed generator AT-URI; pass directly as feed to bsky_get_feed.'),
            displayName: z.string().describe('Feed name supplied by its creator.'),
            description: z
              .string()
              .optional()
              .describe('Feed description supplied by its creator, when present.'),
            creator: z
              .object({
                did: z.string().describe('Permanent DID of the feed creator.'),
                handle: z.string().describe('Handle of the feed creator.'),
                displayName: z
                  .string()
                  .optional()
                  .describe('Creator’s display name, when supplied.'),
              })
              .describe('Identity of the account that created the feed.'),
          })
          .describe('A feed generator in the public catalog.'),
      )
      .describe('Matching feeds in provider order.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque next-page cursor. Its presence signals continuation even when feeds is empty; absent at the end.',
      ),
  }),
  errors: [
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The unstable upstream catalog endpoint is no longer available (HTTP 404 or 410).',
      recovery:
        'Try again later, or discover current topic feeds through bsky_get_trending and read a returned feedUri with bsky_get_feed.',
      thrownBy: 'service',
    },
  ],
  enrichment: {
    totalReturned: z.number().describe('Number of feeds on this page.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when a cursor is present, regardless of the number of feeds returned.'),
    shown: z.number().optional().describe('Number of feeds returned on this page.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
    notice: z.string().optional().describe('Continuation, empty-result, or clamping guidance.'),
  },
  async handler(input, ctx) {
    const { applied: limit, notice: clampNotice } = clampReadLimit(
      ctx,
      'bsky_search_feeds',
      'limit',
      input.limit,
      100,
    );
    const result = await getBlueskyService().searchFeeds(
      {
        query: input.query,
        limit,
        ...(input.cursor !== undefined && input.cursor !== '' ? { cursor: input.cursor } : {}),
      },
      ctx,
    );
    ctx.enrich({ totalReturned: result.feeds.length });
    if (result.cursor !== undefined) {
      ctx.enrich.truncated({
        shown: result.feeds.length,
        cap: limit,
        guidance: composeNotices(
          clampNotice,
          'Pass the returned cursor with the same query to fetch the next page of feeds.',
        ),
      });
    } else if (result.feeds.length === 0) {
      ctx.enrich.notice(
        composeNotices(
          clampNotice,
          input.cursor
            ? 'No more feeds in this catalog traversal.'
            : 'No feeds matched this catalog query. Try broader feed names or descriptions.',
        ),
      );
    } else if (clampNotice) {
      ctx.enrich.notice(clampNotice);
    }
    return result;
  },
  format: (result) => {
    const lines: string[] = [];
    for (const feed of result.feeds) {
      lines.push(
        '## Feed',
        `**Feed URI:** ${destinationLink(feed.feedUri)}`,
        '**Name:**',
        ...quoteUserText(feed.displayName),
      );
      if (feed.description !== undefined)
        lines.push('**Description:**', ...quoteUserText(feed.description));
      lines.push(
        '**Creator DID:**',
        ...quoteUserText(feed.creator.did),
        '**Creator handle:**',
        ...quoteUserText(feed.creator.handle),
      );
      if (feed.creator.displayName !== undefined)
        lines.push('**Creator name:**', ...quoteUserText(feed.creator.displayName));
    }
    if (result.feeds.length === 0) lines.push('No feeds on this page.');
    if (result.cursor !== undefined) lines.push('**Cursor:**', ...quoteUserText(result.cursor));
    return [{ type: 'text', text: closeQuotes(lines).join('\n') }];
  },
});

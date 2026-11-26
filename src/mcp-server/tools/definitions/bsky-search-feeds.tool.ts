/**
 * @fileoverview Keyless feed-generator discovery in two modes — catalog metadata search by query, or
 * one account's generators by actor — with opaque continuation and literal rendering.
 * @module mcp-server/tools/definitions/bsky-search-feeds
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { closeQuotes, destinationLink, quoteUserText } from '@/mcp-server/tools/post-format.js';
import { clampReadLimit, composeNotices, readLimitSchema } from '@/mcp-server/tools/read-limits.js';
import {
  ACTOR_REF_MESSAGE,
  ACTOR_REF_REGEX,
  actorFromRef,
  NON_BLANK_MESSAGE,
  NON_BLANK_REGEX,
} from '@/services/bluesky/at-syntax.js';
import { getBlueskyService, UNCONFIRMED_ACTOR_NOTICE } from '@/services/bluesky/bluesky-service.js';

export const bskySearchFeeds = tool('bsky_search_feeds', {
  title: 'Search Bluesky Feeds',
  description:
    'Find feed generators without credentials, in one of two modes. query searches names and descriptions in the provider’s public feed catalog — not post text, and not every feed — through app.bsky.unspecced.getPopularFeedGenerators, an unstable upstream API that may change or become unavailable. actor lists every feed generator one account created, through app.bsky.feed.getActorFeeds. Pass exactly one. Both return feeds in provider order with generator AT-URIs, creator identities, and like counts; pass a feedUri to bsky_get_feed to read its posts. Continue with the returned opaque cursor and the same query or actor.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(500)
      .regex(NON_BLANK_REGEX, NON_BLANK_MESSAGE)
      .optional()
      .describe(
        'Feed catalog metadata to search, e.g. "science". Must not be blank. Pass query or actor, not both.',
      ),
    actor: z
      .string()
      .min(1)
      .max(2048)
      .regex(ACTOR_REF_REGEX, ACTOR_REF_MESSAGE)
      .optional()
      .describe(
        'Account whose feed generators to list: a handle (e.g. "bossett.social"), "@handle", DID, or the account’s bsky.app page. Pass query or actor, not both.',
      ),
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
        'Opaque cursor from a previous response. It continues only the mode and value it came from: pass it with the same query, or the same actor. Omit for the first page.',
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
            likeCount: z
              .number()
              .optional()
              .describe(
                'Likes Bluesky counts for this feed; 0 is a real count. Absent when none was supplied.',
              ),
          })
          .describe('A feed generator from the catalog or from the actor’s own feeds.'),
      )
      .describe('Feeds on this page in provider order.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque next-page cursor. Its presence signals continuation even when feeds is empty; absent at the end.',
      ),
  }),
  errors: [
    {
      reason: 'invalid_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The arguments carry neither or both of query and actor.',
      recovery:
        'Pass query to search the feed catalog, or actor to list one account’s feed generators — exactly one of the two.',
    },
    {
      reason: 'actor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Bluesky could not find the actor’s profile, or rejected the actor as an invalid identifier.',
      recovery:
        'Verify the handle or DID with bsky_get_profile, or find the account with bsky_search_actors.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The feed catalog returned its invalid-cursor response for a query request carrying a cursor.',
      recovery:
        'Drop the cursor to restart, or pass the previous response’s cursor unchanged with the same query.',
      thrownBy: 'service',
    },
    {
      reason: 'catalog_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The unstable upstream catalog endpoint behind query is no longer available (HTTP 404 or 410).',
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
    notice: z
      .string()
      .optional()
      .describe(
        'Continuation, empty-result, or clamping guidance. An empty actor page for a DID adds that Bluesky did not confirm the account exists when its profile check could not finish.',
      ),
  },
  async handler(input, ctx) {
    const { query, actor: actorRef } = input;
    const mode =
      query !== undefined && actorRef === undefined
        ? ({ kind: 'query', query } as const)
        : query === undefined && actorRef !== undefined
          ? ({ kind: 'actor', actor: actorFromRef(actorRef) } as const)
          : undefined;
    if (!mode) throw ctx.fail('invalid_mode');
    const { applied: limit, notice: clampNotice } = clampReadLimit(
      ctx,
      'bsky_search_feeds',
      'limit',
      input.limit,
      100,
    );
    const page = {
      limit,
      ...(input.cursor !== undefined && input.cursor !== '' ? { cursor: input.cursor } : {}),
    };
    const service = getBlueskyService();
    const result =
      mode.kind === 'query'
        ? await service.searchFeeds({ query: mode.query, ...page }, ctx)
        : await service.getActorFeeds({ actor: mode.actor, ...page }, ctx);
    const notices =
      mode.kind === 'query'
        ? {
            next: 'Pass the returned cursor with the same query to fetch the next page of feeds.',
            exhausted: 'No more feeds in this catalog traversal.',
            none: 'No feeds matched this catalog query. Try broader feed names or descriptions.',
          }
        : {
            next: `Pass the returned cursor with the same actor to fetch the next page of feeds by "${mode.actor}".`,
            exhausted: `No more feeds by "${mode.actor}" — the previous page was the last.`,
            none: `No feed generators found for actor "${mode.actor}".`,
          };
    ctx.enrich({ totalReturned: result.feeds.length });
    if (result.cursor !== undefined) {
      ctx.enrich.truncated({
        shown: result.feeds.length,
        cap: limit,
        guidance: composeNotices(clampNotice, notices.next),
      });
    } else if (result.feeds.length === 0) {
      ctx.enrich.notice(
        composeNotices(
          clampNotice,
          input.cursor ? notices.exhausted : notices.none,
          result.actorUnconfirmed ? UNCONFIRMED_ACTOR_NOTICE : undefined,
        ),
      );
    } else if (clampNotice) {
      ctx.enrich.notice(clampNotice);
    }
    const { actorUnconfirmed: _unconfirmed, ...output } = result;
    return output;
  },
  format: (result) => {
    const lines: string[] = [];
    for (const feed of result.feeds) {
      lines.push('## Feed', `**Feed URI:** ${destinationLink(feed.feedUri)}`);
      if (feed.likeCount !== undefined) lines.push(`**Likes:** ${feed.likeCount}`);
      lines.push('**Name:**', ...quoteUserText(feed.displayName));
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

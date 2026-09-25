/**
 * @fileoverview Fetch real-time trending topics on Bluesky. Each trend is backed by a feed
 * generator, and its `feedUri` is how an agent reads the trend's posts through bsky_get_feed.
 * Topic names and the display names of the accounts driving them render inside lines this file
 * writes, so both go through the shared inline framing; the story summary is quoted.
 * @module mcp-server/tools/definitions/bsky-get-trending
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  actorLabel,
  closeQuotes,
  inlineUserText,
  quoteUserText,
} from '@/mcp-server/tools/post-format.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

/** `app.bsky.unspecced.getTrends` lexicon `maximum` for `limit`. */
const TRENDS_MAX = 25;

const TrendSchema = z
  .object({
    topic: z
      .string()
      .describe(
        'Record key of the feed generator behind this trend, e.g. "1d558a3bc9ff" — an identifier, ' +
          "not a search term. Read the trend's posts through feedUri.",
      ),
    displayName: z.string().describe('Human-readable topic name, e.g. "AI Launch 2025".'),
    description: z
      .string()
      .optional()
      .describe(
        "Bluesky's one-sentence summary of the story behind the trend. Third-party text, rendered quoted.",
      ),
    feedUri: z
      .string()
      .optional()
      .describe(
        "AT-URI of the feed that collects this trend's posts — pass it to bsky_get_feed as-is to read " +
          'them. Parsed from link; absent when link is missing or is not a feed page.',
      ),
    link: z
      .string()
      .optional()
      .describe(
        "The trend feed's page on bsky.app (https://bsky.app/profile/…/feed/…), if provided.",
      ),
    startedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when this topic started trending.'),
    postCount: z.number().optional().describe('Approximate number of posts about this topic.'),
    status: z
      .string()
      .optional()
      .describe('Velocity signal as Bluesky reports it, e.g. "hot", "cooling", or "stale".'),
    category: z
      .string()
      .optional()
      .describe('Category of the trend, e.g. "politics", "sports", "pop-culture".'),
    actors: z
      .array(
        z
          .object({
            did: z.string().describe('Permanent DID of the actor.'),
            handle: z.string().describe('Human-readable handle, e.g. "alice.bsky.social".'),
            displayName: z.string().optional().describe('Display name set by the actor.'),
          })
          .describe('A representative account posting about this topic.'),
      )
      .optional()
      .describe(
        'Representative accounts posting about this topic — the AppView returns five per trend. ' +
          'Pass a handle to bsky_get_author_feed or bsky_get_profile instead of searching for authors.',
      ),
  })
  .describe('A single real-time trending topic on Bluesky.');

export const bskyGetTrending = tool('bsky_get_trending', {
  title: 'Get Bluesky Trending Topics',
  description:
    'Fetch the current real-time trending topics on Bluesky. Returns topics with display name, ' +
    "Bluesky's one-sentence summary of the story, post count, category (politics, sports, pop-culture, " +
    'etc.), status, start time, and the representative accounts driving each topic — so "who is talking ' +
    'about this" needs no follow-up call. Entry point for "what is Bluesky talking about right now". ' +
    "Each trend is a feed: pass its feedUri to bsky_get_feed to read the trend's posts. Note: uses the " +
    "app.bsky.unspecced.getTrends endpoint, which is not part of Bluesky's stable lexicon and may change " +
    'without notice.',
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(TRENDS_MAX)
      .default(10)
      .describe(
        "Maximum number of trending topics to return (1–25). Default 10. 25 is Bluesky's maximum.",
      ),
  }),
  output: z.object({
    trends: z.array(TrendSchema).describe('Current trending topics, ordered by prominence.'),
  }),

  enrichment: {
    totalReturned: z.number().describe('Number of trending topics returned.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more topics were trending than limit — raising limit shows them. Never set at ' +
          "limit 25, Bluesky's maximum.",
      ),
    shown: z.number().optional().describe('Number of trending topics returned.'),
    cap: z.number().optional().describe('The limit applied to this request.'),
    notice: z.string().optional().describe('Guidance when the result set is empty or constrained.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Fetching Bluesky trending topics', { limit: input.limit });
    /**
     * getTrends has no cursor or total, and serves the first N topics of one ranked list, so one
     * topic past the limit is an exact "more are trending" sentinel. At 25 there is nothing past
     * the ceiling to ask for — the endpoint answers 26 with HTTP 400.
     */
    const result = await getBlueskyService().getTrends(
      { limit: Math.min(input.limit + 1, TRENDS_MAX) },
      ctx,
    );
    const trends = result.trends.slice(0, input.limit);
    ctx.enrich({ totalReturned: trends.length });
    if (result.trends.length > input.limit) {
      ctx.enrich.truncated({
        shown: trends.length,
        cap: input.limit,
        guidance: 'More topics are trending — raise limit (max 25) to see them.',
      });
    }
    return { trends };
  },

  format: (result) => {
    if (result.trends.length === 0) {
      return [{ type: 'text', text: 'No trending topics available at this time.' }];
    }
    const lines = result.trends.map((t, i) => {
      /**
       * The topic stands in for a display name that folds to nothing — an empty `**…**` would render
       * as `****`, a thematic break, rather than as the trend's name.
       */
      const parts = [`${i + 1}. **${inlineUserText(t.displayName) || t.topic}**`];
      const meta: string[] = [];
      if (t.postCount != null) meta.push(`${t.postCount.toLocaleString()} posts`);
      if (t.category) meta.push(t.category);
      if (t.status) meta.push(t.status);
      if (meta.length) parts.push(`   ${meta.join(' · ')}`);
      if (t.description) parts.push(...quoteUserText(t.description).map((l) => `   ${l}`));
      if (t.startedAt) parts.push(`   Started: ${t.startedAt}`);
      if (t.topic !== t.displayName) parts.push(`   Topic: \`${t.topic}\``);
      if (t.feedUri) parts.push(`   Feed: \`${t.feedUri}\` — read with bsky_get_feed`);
      if (t.link) parts.push(`   Link: ${t.link}`);
      if (t.actors?.length) {
        parts.push('   Voices:');
        for (const a of t.actors) {
          parts.push(`     - ${actorLabel(a)} \`${a.did}\``);
        }
      }
      return closeQuotes(parts).join('\n');
    });
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});

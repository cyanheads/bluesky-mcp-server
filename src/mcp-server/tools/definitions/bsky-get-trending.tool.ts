/**
 * @fileoverview Fetch real-time trending topics on Bluesky.
 * @module mcp-server/tools/definitions/bsky-get-trending
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

const TrendSchema = z
  .object({
    topic: z
      .string()
      .describe(
        'Opaque topic slug, e.g. "ailaunch2025". Use as a search term in bsky_search_posts.',
      ),
    displayName: z.string().describe('Human-readable topic name, e.g. "AI Launch 2025".'),
    link: z
      .string()
      .optional()
      .describe(
        'Full URL associated with this trending topic (e.g. https://bsky.app/…), if provided.',
      ),
    startedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when this topic started trending.'),
    postCount: z.number().optional().describe('Approximate number of posts about this topic.'),
    status: z.string().optional().describe('Velocity signal, e.g. "hot" or "rising".'),
    category: z
      .string()
      .optional()
      .describe('Category of the trend, e.g. "politics", "sports", "pop-culture".'),
  })
  .describe('A single real-time trending topic on Bluesky.');

export const bskyGetTrending = tool('bsky_get_trending', {
  title: 'Get Bluesky Trending Topics',
  description:
    'Fetch the current real-time trending topics on Bluesky. Returns topics with display name, ' +
    'post count, category (politics, sports, pop-culture, etc.), status (hot/rising), and start time. ' +
    'Entry point for "what is Bluesky talking about right now". Pair with bsky_search_posts to drill ' +
    'into any trending topic. Note: uses the app.bsky.unspecced.getTrends endpoint, which is not part ' +
    "of Bluesky's stable lexicon and may change without notice.",
  annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  input: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe('Maximum number of trending topics to return (1–25). Default 10.'),
  }),
  output: z.object({
    trends: z.array(TrendSchema).describe('Current trending topics, ordered by prominence.'),
  }),

  enrichment: {
    totalReturned: z.number().describe('Number of trending topics returned.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when the topic list was capped at the requested limit; more may exist.'),
    shown: z.number().optional().describe('Number of trending topics returned.'),
    cap: z.number().optional().describe('The limit applied to this request.'),
    notice: z.string().optional().describe('Guidance when the result set is empty or constrained.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Fetching Bluesky trending topics', { limit: input.limit });
    const result = await getBlueskyService().getTrends({ limit: input.limit }, ctx);
    ctx.enrich({ totalReturned: result.trends.length });
    if (result.trends.length >= input.limit) {
      ctx.enrich.truncated({
        shown: result.trends.length,
        cap: input.limit,
        guidance:
          'The topic list was capped at the requested limit — raise limit (max 25) for more.',
      });
    }
    return { trends: result.trends };
  },

  format: (result) => {
    if (result.trends.length === 0) {
      return [{ type: 'text', text: 'No trending topics available at this time.' }];
    }
    const lines = result.trends.map((t, i) => {
      const parts = [`${i + 1}. **${t.displayName}**`];
      const meta: string[] = [];
      if (t.postCount != null) meta.push(`${t.postCount.toLocaleString()} posts`);
      if (t.category) meta.push(t.category);
      if (t.status) meta.push(t.status);
      if (meta.length) parts.push(`   ${meta.join(' · ')}`);
      if (t.startedAt) parts.push(`   Started: ${t.startedAt}`);
      if (t.topic !== t.displayName) parts.push(`   Topic: \`${t.topic}\``);
      if (t.link) parts.push(`   Link: ${t.link}`);
      return parts.join('\n');
    });
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});

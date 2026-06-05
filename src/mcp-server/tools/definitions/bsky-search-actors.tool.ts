/**
 * @fileoverview Search Bluesky accounts by name or handle fragment.
 * @module mcp-server/tools/definitions/bsky-search-actors
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

const ActorResultSchema = z
  .object({
    did: z.string().describe('Decentralized Identifier — permanent portable identity key.'),
    handle: z.string().describe('Human-readable username, e.g. "alice.bsky.social".'),
    displayName: z.string().optional().describe('Display name set by the user.'),
    description: z.string().optional().describe('Biography / about text.'),
    avatar: z.string().optional().describe('URL of the profile avatar image.'),
    followersCount: z.number().optional().describe('Number of followers.'),
    labels: z
      .array(
        z
          .object({
            val: z.string().describe('Label value (content warning or moderation tag).'),
            src: z.string().optional().describe('DID of the labeling service.'),
          })
          .describe('A moderation label applied to this actor.'),
      )
      .optional()
      .describe('Moderation labels applied to this actor.'),
  })
  .describe('A Bluesky actor profile summary.');

export const bskySearchActors = tool('bsky_search_actors', {
  title: 'Search Bluesky Actors',
  description:
    'Find Bluesky accounts by name or handle fragment. Returns ranked profiles with handle, ' +
    'DID, displayName, bio, and follower count. Use before bsky_get_profile or bsky_get_author_feed ' +
    'when you have a name but not a confirmed handle. Supports cursor-based pagination for browsing ' +
    'beyond the first page of results.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .describe('Name or handle fragment to search for, e.g. "alice" or "nytimes.com".'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of actors to return (1–100). Default 25.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque pagination cursor from a previous response. Omit for the first page.'),
  }),
  output: z.object({
    actors: z.array(ActorResultSchema).describe('Matching actor profiles, ranked by relevance.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor for the next page. Absent on the last page.'),
  }),

  enrichment: {
    totalReturned: z.number().describe('Number of actors in this response page.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Searching Bluesky actors', { query: input.query, limit: input.limit });
    const result = await getBlueskyService().searchActors(
      { q: input.query, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
      ctx,
    );
    ctx.enrich({ totalReturned: result.actors.length });
    if (result.actors.length === 0) {
      ctx.enrich.notice(
        `No actors matched "${input.query}". Try a different name or handle fragment.`,
      );
    }
    return { actors: result.actors, ...(result.cursor ? { cursor: result.cursor } : {}) };
  },

  format: (result) => {
    if (result.actors.length === 0) {
      return [{ type: 'text', text: 'No matching actors found.' }];
    }
    const lines = result.actors.map((a) => {
      const parts = [`## @${a.handle}`];
      parts.push(`**DID:** \`${a.did}\``);
      if (a.displayName) parts.push(`**Name:** ${a.displayName}`);
      if (a.description) parts.push(a.description);
      if (a.followersCount != null)
        parts.push(`**Followers:** ${a.followersCount.toLocaleString()}`);
      if (a.labels?.length) {
        const labelParts = a.labels.map((l) => (l.src ? `${l.val} (src:${l.src})` : l.val));
        parts.push(`**Labels:** ${labelParts.join(', ')}`);
      }
      if (a.avatar) parts.push(`**Avatar:** ${a.avatar}`);
      return parts.join('\n');
    });
    const output = lines.join('\n\n');
    return [
      {
        type: 'text',
        text: result.cursor ? `${output}\n\n---\n*cursor: \`${result.cursor}\`*` : output,
      },
    ];
  },
});

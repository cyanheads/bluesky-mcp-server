/**
 * @fileoverview Search Bluesky accounts by name or handle fragment. Each bio is
 * rendered through the shared blockquote framing, since it is text the account holder
 * wrote and can carry its own markdown structure; display names, pronouns, and label
 * values, which render inside lines this file writes, go through the inline framing
 * instead.
 * @module mcp-server/tools/definitions/bsky-search-actors
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  closeQuotes,
  inlineUserText,
  quoteUserText,
  verificationSuffix,
} from '@/mcp-server/tools/post-format.js';
import { NON_BLANK_MESSAGE, NON_BLANK_REGEX } from '@/services/bluesky/at-syntax.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

const ActorResultSchema = z
  .object({
    did: z.string().describe('Decentralized Identifier — permanent portable identity key.'),
    handle: z.string().describe('Human-readable username, e.g. "alice.bsky.social".'),
    displayName: z.string().optional().describe('Display name set by the user.'),
    description: z.string().optional().describe('Biography / about text.'),
    pronouns: z
      .string()
      .optional()
      .describe(
        'Free-form pronouns the account set, e.g. "they/he". Absent when it set none. Account-authored ' +
          'text bounded only by length, not a fixed vocabulary — read it as written rather than parsing it.',
      ),
    avatar: z.string().optional().describe('URL of the profile avatar image.'),
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
    verification: z
      .object({
        verifiedStatus: z
          .string()
          .describe(
            'Whether a trusted verifier verified this account: "valid", "invalid" (verified once, no ' +
              'longer holds), or "none". Passed through as Bluesky sends it, so another value may appear.',
          ),
        trustedVerifierStatus: z
          .string()
          .describe(
            'Whether this account is itself a trusted verifier — same values as verifiedStatus.',
          ),
      })
      .optional()
      .describe(
        'Bluesky verification of this account — what tells it from a look-alike handle. Absent when ' +
          'Bluesky sent none. Who issued it is on bsky_get_profile.',
      ),
  })
  .describe('A Bluesky actor profile summary.');

export const bskySearchActors = tool('bsky_search_actors', {
  title: 'Search Bluesky Actors',
  description:
    'Find Bluesky accounts by name or handle fragment. Returns ranked profiles with handle, ' +
    'DID, displayName, bio, pronouns when the account set them, and Bluesky verification status — ' +
    'which tells a verified account from a look-alike handle. Follower, following, and post ' +
    'counts and the website are not on this view — bsky_get_profile returns them for one account. ' +
    'Use before bsky_get_profile or bsky_get_author_feed when you have a name but not a confirmed ' +
    'handle. Supports cursor-based pagination for browsing beyond the first page of results.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(500)
      .regex(NON_BLANK_REGEX, NON_BLANK_MESSAGE)
      .describe(
        'Name or handle fragment to search for, e.g. "alice" or "nytimes.com". Must not be blank.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of actors to return (1–100). Default 25.'),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'Opaque pagination cursor from a previous response to the same query. Omit for the first page.',
      ),
  }),
  output: z.object({
    actors: z.array(ActorResultSchema).describe('Matching actor profiles, ranked by relevance.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque cursor for the next page — pass it back with the same query. Absent on the last page.',
      ),
  }),

  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Bluesky could not continue from the cursor the request carried — it answers a cursor it cannot decode with HTTP 400.',
      recovery:
        'Drop the cursor to start again from the first page, or pass the cursor exactly as the previous response for this same query returned it.',
      thrownBy: 'service',
    },
  ],

  enrichment: {
    totalReturned: z.number().describe('Number of actors in this response page.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when Bluesky returned a cursor for another page, whatever this page held — pages often ' +
          'hold fewer actors than limit and still continue.',
      ),
    shown: z.number().optional().describe('Number of actors returned on this page.'),
    cap: z.number().optional().describe('The limit applied to this page.'),
    notice: z.string().optional().describe('Guidance when the result set is empty or constrained.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Searching Bluesky actors', { query: input.query, limit: input.limit });
    const result = await getBlueskyService().searchActors(
      { q: input.query, limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
      ctx,
    );
    ctx.enrich({ totalReturned: result.actors.length });
    if (result.cursor) {
      ctx.enrich.truncated({
        shown: result.actors.length,
        cap: input.limit,
        guidance: 'Pass the returned cursor to fetch the next page of actors.',
      });
    } else if (result.actors.length === 0) {
      ctx.enrich.notice(
        input.cursor
          ? `No more actors match "${input.query}" — the previous page was the last.`
          : `No actors matched "${input.query}". Try a different name or handle fragment.`,
      );
    }
    return { actors: result.actors, ...(result.cursor ? { cursor: result.cursor } : {}) };
  },

  format: (result) => {
    const footer = result.cursor ? `\n\n---\n*cursor: \`${result.cursor}\`*` : '';
    if (result.actors.length === 0) {
      return [{ type: 'text', text: `No actors on this page.${footer}` }];
    }
    const lines = result.actors.map((a) => {
      const parts = [`## @${a.handle}`];
      parts.push(`**DID:** \`${a.did}\`${verificationSuffix(a.verification)}`);
      if (a.displayName) parts.push(`**Name:** ${inlineUserText(a.displayName)}`);
      if (a.pronouns) parts.push(`**Pronouns:** ${inlineUserText(a.pronouns)}`);
      if (a.description) parts.push(...quoteUserText(a.description));
      if (a.labels?.length) {
        const labelParts = a.labels.map((l) => {
          const val = inlineUserText(l.val);
          return l.src ? `${val} (src:${l.src})` : val;
        });
        parts.push(`**Labels:** ${labelParts.join(', ')}`);
      }
      if (a.avatar) parts.push(`**Avatar:** ${a.avatar}`);
      return closeQuotes(parts).join('\n');
    });
    return [{ type: 'text', text: `${lines.join('\n\n')}${footer}` }];
  },
});

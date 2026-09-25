/**
 * @fileoverview Bluesky actor public profile resource, addressable by handle or DID.
 * @module mcp-server/resources/definitions/bsky-profile
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { ACTOR_REF_MESSAGE, ACTOR_REF_REGEX, actorFromRef } from '@/services/bluesky/at-syntax.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

export const bskyProfileResource = resource('bsky://profile/{actor}', {
  name: 'bsky-profile',
  description:
    "A Bluesky actor's public profile, addressable by handle or DID, with or without a leading " +
    '"@" (bsky://profile/@bsky.app). Returns the same data as bsky_get_profile in injectable-context ' +
    'form — displayName, handle, DID, bio, pronouns, website, follower/following/post counts, avatar, ' +
    'moderation labels, and pinned post AT-URI.',
  mimeType: 'application/json',
  params: z.object({
    actor: z
      .string()
      .min(1)
      .max(2048)
      .regex(ACTOR_REF_REGEX, ACTOR_REF_MESSAGE)
      .describe(
        'Handle (e.g. "alice.bsky.social", or "@alice.bsky.social") or DID (e.g. "did:plc:z72i7hdynmk6r22z27h6tvur") of the actor.',
      ),
  }),
  errors: [
    {
      reason: 'actor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The handle does not resolve or the profile does not exist.',
      recovery: 'Verify the handle spelling or use bsky_search_actors to find the correct handle.',
    },
  ],

  async handler(params, ctx) {
    const actor = actorFromRef(params.actor);
    ctx.log.debug('Fetching Bluesky profile resource', { actor });
    try {
      return await getBlueskyService().getProfile(actor, ctx);
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
  },

  list: async () => ({
    resources: [
      {
        uri: 'bsky://profile/bsky.app',
        name: 'Bluesky official profile (bsky.app)',
        mimeType: 'application/json',
      },
    ],
  }),
});

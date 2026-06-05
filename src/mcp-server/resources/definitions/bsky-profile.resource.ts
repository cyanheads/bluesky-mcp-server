/**
 * @fileoverview Bluesky actor public profile resource, addressable by handle or DID.
 * @module mcp-server/resources/definitions/bsky-profile
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

export const bskyProfileResource = resource('bsky://profile/{actor}', {
  name: 'bsky-profile',
  description:
    "A Bluesky actor's public profile, addressable by handle or DID. Returns the same data as " +
    'bsky_get_profile in injectable-context form — displayName, handle, DID, bio, follower/following/post ' +
    'counts, avatar, moderation labels, and pinned post AT-URI.',
  mimeType: 'application/json',
  params: z.object({
    actor: z
      .string()
      .describe(
        'Handle (e.g. "alice.bsky.social") or DID (e.g. "did:plc:z72i7hdynmk6r22z27h6tvur") of the actor.',
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
    ctx.log.debug('Fetching Bluesky profile resource', { actor: params.actor });
    return getBlueskyService().getProfile(params.actor, ctx);
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

/**
 * @fileoverview Fetch a Bluesky actor's public profile by handle or DID.
 * @module mcp-server/tools/definitions/bsky-get-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

const LabelSchema = z
  .object({
    val: z
      .string()
      .describe('Label value (content warning or moderation tag, e.g. "porn", "spam").'),
    src: z.string().optional().describe('DID of the labeler that applied this label.'),
    cts: z.string().optional().describe('ISO 8601 timestamp when the label was applied.'),
  })
  .describe('A moderation label applied by the AppView or a labeler service.');

export const bskyGetProfile = tool('bsky_get_profile', {
  title: 'Get Bluesky Profile',
  description:
    'Fetch a Bluesky actor\'s public profile by handle (e.g. "bsky.app") or DID ' +
    '(e.g. "did:plc:z72i7hdynmk6r22z27h6tvur"). Returns displayName, handle, DID, bio, ' +
    'follower/following/post counts, avatar URL, moderation labels, and pinned post AT-URI. ' +
    'Use this as the first step to resolve a handle to a DID before calling tools that require ' +
    'a DID or AT-URI. Handles and DIDs are interchangeable as input.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    actor: z
      .string()
      .describe(
        'Handle (e.g. "bsky.app", "alice.bsky.social") or DID (e.g. "did:plc:z72i7hdynmk6r22z27h6tvur") of the actor to look up.',
      ),
  }),
  output: z.object({
    did: z
      .string()
      .describe(
        'Decentralized Identifier — the permanent, portable identity key for this account.',
      ),
    handle: z.string().describe('Human-readable username, e.g. "alice.bsky.social".'),
    displayName: z
      .string()
      .optional()
      .describe('Display name set by the user. May differ from the handle.'),
    description: z.string().optional().describe('Biography / about text.'),
    avatar: z.string().optional().describe('URL of the profile avatar image.'),
    followersCount: z.number().optional().describe('Number of accounts following this actor.'),
    followsCount: z.number().optional().describe('Number of accounts this actor follows.'),
    postsCount: z.number().optional().describe('Total posts authored by this actor.'),
    labels: z.array(LabelSchema).optional().describe('Moderation labels applied to this profile.'),
    indexedAt: z
      .string()
      .optional()
      .describe('ISO 8601 timestamp when the AppView last indexed this profile.'),
    createdAt: z.string().optional().describe('ISO 8601 timestamp of account creation.'),
    pinnedPostUri: z
      .string()
      .optional()
      .describe('AT-URI of the pinned post, if any. Pass to bsky_get_post_thread to read it.'),
  }),

  errors: [
    {
      reason: 'actor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The handle does not resolve or the profile does not exist.',
      recovery: 'Verify the handle spelling or use bsky_search_actors to find the correct handle.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching Bluesky profile', { actor: input.actor });
    const profile = await getBlueskyService().getProfile(input.actor, ctx);
    return profile;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.displayName ?? result.handle}`);
    lines.push(`**Handle:** @${result.handle} | **DID:** \`${result.did}\``);
    if (result.description) lines.push(`\n${result.description}`);
    const counts: string[] = [];
    if (result.followersCount != null)
      counts.push(`${result.followersCount.toLocaleString()} followers`);
    if (result.followsCount != null)
      counts.push(`following ${result.followsCount.toLocaleString()}`);
    if (result.postsCount != null) counts.push(`${result.postsCount.toLocaleString()} posts`);
    if (counts.length) lines.push(`\n${counts.join(' · ')}`);
    if (result.avatar) lines.push(`\n**Avatar:** ${result.avatar}`);
    if (result.pinnedPostUri) lines.push(`**Pinned post AT-URI:** \`${result.pinnedPostUri}\``);
    if (result.labels?.length) {
      const labelParts = result.labels.map((l) => {
        const parts = [l.val];
        if (l.src) parts.push(`src:${l.src}`);
        if (l.cts) parts.push(`cts:${l.cts}`);
        return parts.join(' ');
      });
      lines.push(`**Labels:** ${labelParts.join(', ')}`);
    }
    if (result.createdAt) lines.push(`**Joined:** ${result.createdAt}`);
    if (result.indexedAt) lines.push(`**Indexed:** ${result.indexedAt}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * @fileoverview Fetch social graph edges for a Bluesky account — followers or following.
 * @module mcp-server/tools/definitions/bsky-get-follows
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { GraphResult } from '@/services/bluesky/types.js';

const ActorSchema = z
  .object({
    did: z.string().describe('Decentralized Identifier of the actor.'),
    handle: z.string().describe('Human-readable handle, e.g. "alice.bsky.social".'),
    displayName: z.string().optional().describe('Display name set by the user.'),
    description: z.string().optional().describe('Biography / about text.'),
    avatar: z.string().optional().describe('Avatar image URL.'),
    followersCount: z.number().optional().describe('Number of followers.'),
    labels: z
      .array(
        z
          .object({
            val: z
              .string()
              .describe('Label value (content warning or moderation tag, e.g. "porn", "spam").'),
          })
          .describe('A moderation label.'),
      )
      .optional()
      .describe('Moderation labels.'),
  })
  .describe('A Bluesky actor in the social graph.');

export const bskyGetFollows = tool('bsky_get_follows', {
  title: 'Get Bluesky Social Graph',
  description:
    'Fetch the social graph edges for a Bluesky account — who follows them, or who they follow. ' +
    'Returns paginated actor profiles (handle, DID, displayName, bio, follower count) plus a summary ' +
    'of the subject account. Accounts with large social graphs return only the first page; use ' +
    'cursor pagination to walk through the full list.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    actor: z.string().describe('Handle (e.g. "alice.bsky.social") or DID of the account to query.'),
    direction: z
      .enum(['followers', 'following'])
      .describe(
        '"followers" returns accounts that follow this actor. "following" returns accounts this actor follows.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe('Maximum number of actors to return per page (1–100). Default 25.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque pagination cursor from a previous response. Omit for the first page.'),
  }),
  output: z.object({
    actors: z.array(ActorSchema).describe('Actors in the requested direction of the social graph.'),
    subject: z
      .object({
        did: z.string().describe('Permanent DID of the queried account.'),
        handle: z.string().describe('Human-readable handle of the queried account.'),
        displayName: z.string().optional().describe('Subject display name.'),
        followersCount: z.number().optional().describe("Subject's follower count."),
        followsCount: z.number().optional().describe("Subject's following count."),
      })
      .describe('Profile summary of the queried actor.'),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor for the next page. Absent on the last page.'),
  }),

  errors: [
    {
      reason: 'actor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The actor handle or DID does not resolve to an existing account.',
      recovery: 'Verify the actor handle or DID, or use bsky_search_actors to confirm the handle.',
    },
  ],

  enrichment: {
    totalReturned: z.number().describe('Number of actors in this response page.'),
  },

  async handler(input, ctx) {
    ctx.log.info('Fetching Bluesky social graph', {
      actor: input.actor,
      direction: input.direction,
      limit: input.limit,
    });
    const params = {
      actor: input.actor,
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    };
    let result: GraphResult;
    try {
      result =
        input.direction === 'followers'
          ? await getBlueskyService().getFollowers(params, ctx)
          : await getBlueskyService().getFollows(params, ctx);
    } catch (err) {
      if (err instanceof McpError) {
        const body = (err.data as { responseBody?: string } | undefined)?.responseBody ?? '';
        if (
          err.data &&
          (body.includes('not found') || body.includes('Not Found') || body.includes('NotFound'))
        ) {
          throw ctx.fail(
            'actor_not_found',
            `Actor not found: "${input.actor}"`,
            ctx.recoveryFor('actor_not_found'),
          );
        }
      }
      throw err;
    }

    ctx.enrich({ totalReturned: result.actors.length });
    if (result.actors.length === 0) {
      ctx.enrich.notice(`No ${input.direction} found for actor "${input.actor}".`);
    }

    const { followersCount, followsCount, did, handle, displayName } = result.subject;
    return {
      actors: result.actors,
      subject: {
        did,
        handle,
        ...(displayName ? { displayName } : {}),
        ...(followersCount != null ? { followersCount } : {}),
        ...(followsCount != null ? { followsCount } : {}),
      },
      ...(result.cursor ? { cursor: result.cursor } : {}),
    };
  },

  format: (result) => {
    const subjectLabel = result.subject.displayName
      ? `${result.subject.displayName} (@${result.subject.handle})`
      : `@${result.subject.handle}`;
    const header: string[] = [`## Subject: ${subjectLabel}`];
    header.push(`**DID:** \`${result.subject.did}\``);
    if (result.subject.followersCount != null)
      header.push(`Followers: ${result.subject.followersCount.toLocaleString()}`);
    if (result.subject.followsCount != null)
      header.push(`Following: ${result.subject.followsCount.toLocaleString()}`);

    if (result.actors.length === 0) {
      return [{ type: 'text', text: `${header.join('\n')}\n\n*No accounts found.*` }];
    }

    const actorLines = result.actors.map((a) => {
      const parts = [`### @${a.handle}`];
      parts.push(`**DID:** \`${a.did}\``);
      if (a.displayName) parts.push(`**Name:** ${a.displayName}`);
      if (a.description) parts.push(a.description);
      if (a.followersCount != null)
        parts.push(`**Followers:** ${a.followersCount.toLocaleString()}`);
      if (a.labels?.length) parts.push(`**Labels:** ${a.labels.map((l) => l.val).join(', ')}`);
      if (a.avatar) parts.push(`**Avatar:** ${a.avatar}`);
      return parts.join('\n');
    });

    const footer = result.cursor ? `\n\n---\n*cursor: \`${result.cursor}\`*` : '';
    return [
      {
        type: 'text',
        text: `${header.join('\n')}\n\n---\n\n${actorLines.join('\n\n')}${footer}`,
      },
    ];
  },
});

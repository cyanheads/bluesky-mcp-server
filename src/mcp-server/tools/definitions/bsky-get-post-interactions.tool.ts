/**
 * @fileoverview Accounts behind a post's likes or reposts, with account and interaction dates kept distinct.
 * @module mcp-server/tools/definitions/bsky-get-post-interactions
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  closeQuotes,
  inlineUserText,
  quoteUserText,
  renderLabelList,
  verificationSuffix,
} from '@/mcp-server/tools/post-format.js';
import { clampReadLimit, composeNotices, readLimitSchema } from '@/mcp-server/tools/read-limits.js';
import {
  atUriFromRef,
  POST_URI_REF_MESSAGE,
  POST_URI_REF_REGEX,
} from '@/services/bluesky/at-syntax.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';

const ActorSchema = z
  .object({
    did: z.string().describe('Permanent DID of the account.'),
    handle: z.string().describe('Human-readable account handle.'),
    displayName: z.string().optional().describe('Display name set by the account.'),
    description: z.string().optional().describe('Biography written by the account.'),
    pronouns: z.string().optional().describe('Free-form pronouns supplied by the account.'),
    avatar: z.string().optional().describe('Avatar image URL.'),
    createdAt: z
      .string()
      .optional()
      .describe('ISO 8601 account creation timestamp, when supplied.'),
    likedAt: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp when this account liked the post; present for likes only, distinct from account creation.',
      ),
    labels: z
      .array(
        z
          .object({
            val: z.string().describe('Moderation label value.'),
            src: z.string().optional().describe('DID of the labeling service.'),
            cts: z.string().optional().describe('ISO 8601 timestamp when the label was applied.'),
          })
          .describe('A moderation label with optional provenance.'),
      )
      .optional()
      .describe('Moderation labels supplied by Bluesky.'),
    verification: z
      .object({
        verifiedStatus: z
          .string()
          .describe('Account verification status from Bluesky, such as valid, invalid, or none.'),
        trustedVerifierStatus: z
          .string()
          .describe('Trusted-verifier status from Bluesky, such as valid, invalid, or none.'),
      })
      .optional()
      .describe('Verification statuses when supplied; bsky_get_profile returns issuer details.'),
  })
  .describe('An account that liked or reposted the post.');

/** Read one provider page of likers or reposters without credentials. */
export const bskyGetPostInteractions = tool('bsky_get_post_interactions', {
  title: 'Get Bluesky Post Interactions',
  description:
    'List the accounts behind a post’s likes or reposts without credentials, in provider order. Accepts a post AT-URI or bsky.app post URL; a handle authority costs one extra resolution request. Returns actor summaries with account creation and label provenance when supplied, and a separate likedAt timestamp for likes. Account counts and website are available through bsky_get_profile. Post likeCount and repostCount are upper bounds on retrievable interactions: cursor exhaustion does not prove every counted interaction was returned. Follow returned cursors with the same post and kind; no pages are walked automatically. Repost cursors retain Bluesky’s behavior, which can ignore malformed cursors and repeat a page.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    uri: z
      .string()
      .max(2048)
      .regex(POST_URI_REF_REGEX, POST_URI_REF_MESSAGE)
      .describe(
        'Post AT-URI or https://bsky.app/profile/<handle-or-did>/post/<rkey> URL. URL trailing slash, query, and fragment are accepted. Feed, profile, and list references are rejected.',
      ),
    kind: z
      .enum(['likes', 'reposts'])
      .describe(
        'Interaction to list: likes includes likedAt; reposts has no interaction timestamp.',
      ),
    limit: readLimitSchema(100)
      .default(25)
      .describe(
        'Maximum accounts per page, default 25. Values above 100 are clamped with a notice unless read-limit clamping is disabled.',
      ),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'Opaque cursor from the previous response for the same post and kind. Pass unchanged; omit for the first page.',
      ),
  }),
  output: z.object({
    uri: z.string().describe('DID-form AT-URI of the queried post.'),
    kind: z.enum(['likes', 'reposts']).describe('Interaction whose accounts are returned.'),
    actors: z.array(ActorSchema).describe('Accounts in provider order.'),
    cursor: z
      .string()
      .optional()
      .describe(
        'Opaque continuation cursor. Absence ends traversal, without proving every counted interaction was returned.',
      ),
  }),
  enrichment: {
    totalReturned: z.number().describe('Accounts returned on this page.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True exactly when Bluesky returned a cursor, regardless of page size.'),
    shown: z.number().optional().describe('Accounts shown on a page with a continuation cursor.'),
    cap: z
      .number()
      .optional()
      .describe('Applied page limit when a continuation cursor is present.'),
    notice: z
      .string()
      .optional()
      .describe('Pagination, empty-page, clamping, and counter-completeness guidance.'),
  },
  errors: [
    {
      reason: 'post_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The post does not exist or its handle cannot be resolved.',
      recovery: 'Verify the post address or use bsky_get_author_feed to find its current AT-URI.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Bluesky cannot decode the supplied like cursor and returns HTTP 500.',
      recovery:
        'Drop the cursor to restart, or reuse the exact cursor returned for the same post and kind.',
      retryable: false,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const limit = clampReadLimit(ctx, 'bsky_get_post_interactions', 'limit', input.limit, 100);
    const result = await getBlueskyService().getPostInteractions(
      {
        uri: atUriFromRef(input.uri),
        kind: input.kind,
        limit: limit.applied,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
      ctx,
    );
    const completeness =
      'Post counters are upper bounds on retrievable interactions; cursor exhaustion does not prove every counted interaction was returned.';
    const pageNotice = result.cursor
      ? 'Pass the returned cursor with the same post and kind to continue; the next page can be empty.'
      : result.actors.length === 0
        ? input.cursor
          ? 'No more accounts on this traversal.'
          : `No readable ${input.kind} found for this post.`
        : undefined;
    ctx.enrich({ totalReturned: result.actors.length });
    const notice = composeNotices(limit.notice, pageNotice, completeness);
    if (result.cursor)
      ctx.enrich.truncated({ shown: result.actors.length, cap: limit.applied, guidance: notice });
    else ctx.enrich.notice(notice);
    return result;
  },
  format: (result) => {
    const lines = [`## ${result.kind} of \`${result.uri}\``];
    if (result.actors.length === 0) lines.push('No accounts on this page.');
    for (const actor of result.actors) {
      lines.push(
        `### @${actor.handle}`,
        `**DID:** \`${actor.did}\`${verificationSuffix(actor.verification)}`,
      );
      if (actor.displayName) lines.push(`**Name:** ${inlineUserText(actor.displayName)}`);
      if (actor.pronouns) lines.push(`**Pronouns:** ${inlineUserText(actor.pronouns)}`);
      if (actor.createdAt) lines.push(`**Joined:** ${actor.createdAt}`);
      if (actor.likedAt) lines.push(`**Liked:** ${actor.likedAt}`);
      if (actor.description) lines.push(...quoteUserText(actor.description));
      if (actor.labels?.length) lines.push(`**Labels:** ${renderLabelList(actor.labels)}`);
      if (actor.avatar) lines.push(`**Avatar:** ${actor.avatar}`);
    }
    if (result.cursor) lines.push(`*cursor: \`${result.cursor}\`*`);
    return [{ type: 'text', text: closeQuotes(lines).join('\n') }];
  },
});

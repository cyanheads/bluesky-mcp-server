/**
 * @fileoverview Fetch a Bluesky actor's public profile by handle or DID. The bio is
 * rendered through the shared blockquote framing, since it is text the account holder
 * wrote and can carry its own markdown structure; the display name and pronouns, which
 * render inside lines this file writes, go through the inline framing instead, and the
 * label values take it inside the shared label renderer, as does each verification issuer's display
 * name. The avatar and website URLs are left bare — the lexicon types both as URIs.
 * @module mcp-server/tools/definitions/bsky-get-profile
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  closeQuotes,
  inlineUserText,
  quoteUserText,
  renderLabelList,
  verificationSuffix,
} from '@/mcp-server/tools/post-format.js';
import { ACTOR_REF_MESSAGE, ACTOR_REF_REGEX, actorFromRef } from '@/services/bluesky/at-syntax.js';
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
    '(e.g. "did:plc:z72i7hdynmk6r22z27h6tvur"). Returns displayName, handle, DID, bio, pronouns, ' +
    'website, follower/following/post counts, avatar URL, moderation labels, pinned post AT-URI, and ' +
    'Bluesky verification — whether the account is verified or a trusted verifier, and who verified it. ' +
    'Use this as the first step to resolve a handle to a DID before calling tools that require ' +
    'a DID or AT-URI. Handles and DIDs are interchangeable as input, and "@bsky.app" or the ' +
    "account's bsky.app page (https://bsky.app/profile/bsky.app) work as-is.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    actor: z
      .string()
      .min(1)
      .max(2048)
      .regex(ACTOR_REF_REGEX, ACTOR_REF_MESSAGE)
      .describe(
        'Handle (e.g. "bsky.app", "alice.bsky.social") or DID (e.g. "did:plc:z72i7hdynmk6r22z27h6tvur") of the actor to look up. ' +
          'A leading "@" ("@bsky.app") and the account\'s bsky.app page ("https://bsky.app/profile/bsky.app") are ' +
          'accepted and read as the handle or DID they carry. ' +
          'A bare name without a dot is not a handle — use bsky_search_actors to resolve one.',
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
    pronouns: z
      .string()
      .optional()
      .describe(
        'Free-form pronouns the account set, e.g. "they/he". Absent when it set none. Account-authored ' +
          'text bounded only by length, not a fixed vocabulary — read it as written rather than parsing it.',
      ),
    website: z
      .string()
      .optional()
      .describe(
        'URL the account set as its website, in the profile field of that name rather than in the bio. ' +
          'Absent when it set none. The one link on a profile that points somewhere else — follow it before ' +
          'reading the bio for one.',
      ),
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
            'Whether this account is itself a trusted verifier, whose verifications Bluesky honors — ' +
              'same values as verifiedStatus.',
          ),
        verifications: z
          .array(
            z
              .object({
                issuer: z.string().describe('DID of the trusted verifier that issued it.'),
                issuerHandle: z
                  .string()
                  .optional()
                  .describe('Handle of the issuer, when Bluesky sent it.'),
                issuerDisplayName: z
                  .string()
                  .optional()
                  .describe(
                    'Display name of the issuer, when Bluesky sent it. Account-authored text.',
                  ),
                uri: z.string().describe('AT-URI of the verification record.'),
                isValid: z.boolean().describe('Whether this verification still holds.'),
                createdAt: z.string().describe('ISO 8601 timestamp when it was issued.'),
              })
              .describe('One verification a trusted verifier issued for this account.'),
          )
          .describe(
            'Verifications issued by trusted verifiers — empty for an account that verifies others but ' +
              'was never verified itself.',
          ),
      })
      .optional()
      .describe(
        'Bluesky verification state — what tells a verified account from a look-alike handle. Absent ' +
          'when Bluesky sent none, which it does for an account neither verified nor a trusted verifier.',
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

  async handler(input, ctx) {
    const actor = actorFromRef(input.actor);
    ctx.log.info('Fetching Bluesky profile', { actor });
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

  format: (result) => {
    const lines: string[] = [];
    const name = result.displayName ? inlineUserText(result.displayName) : '';
    lines.push(`## ${name || result.handle}`);
    lines.push(
      `**Handle:** @${result.handle} | **DID:** \`${result.did}\`${verificationSuffix(result.verification)}`,
    );
    /**
     * Pronouns take the inline framing rather than the blockquote: they render on a line this file
     * writes, and quoting them would push that label onto a line of its own.
     */
    if (result.pronouns) lines.push(`**Pronouns:** ${inlineUserText(result.pronouns)}`);
    if (result.description) lines.push('', ...quoteUserText(result.description));
    const counts: string[] = [];
    if (result.followersCount != null)
      counts.push(`${result.followersCount.toLocaleString()} followers`);
    if (result.followsCount != null)
      counts.push(`following ${result.followsCount.toLocaleString()}`);
    if (result.postsCount != null) counts.push(`${result.postsCount.toLocaleString()} posts`);
    if (counts.length) lines.push(`\n${counts.join(' · ')}`);
    /**
     * The website URL renders bare, on the same terms as the avatar: the lexicon gives the field
     * `format: "uri"`, so it is a URL by construction and carries no line break to escape with.
     * Both share one leading blank line, whichever of them the account set.
     */
    const urls: string[] = [];
    if (result.website) urls.push(`**Website:** ${result.website}`);
    if (result.avatar) urls.push(`**Avatar:** ${result.avatar}`);
    if (urls.length) lines.push('', ...urls);
    if (result.pinnedPostUri) lines.push(`**Pinned post AT-URI:** \`${result.pinnedPostUri}\``);
    if (result.labels?.length) lines.push(`**Labels:** ${renderLabelList(result.labels)}`);
    if (result.createdAt) lines.push(`**Joined:** ${result.createdAt}`);
    if (result.indexedAt) lines.push(`**Indexed:** ${result.indexedAt}`);
    /**
     * One line per issuance, last and after a blank line so no line below can continue the list. The
     * issuer's display name is the issuer's own writing, so it takes the inline framing; the handle
     * and DID beside it are lexicon-typed identifiers.
     */
    const issued = result.verification?.verifications ?? [];
    if (issued.length) {
      lines.push('', '**Verifications:**');
      for (const v of issued) {
        const issuerName = v.issuerDisplayName ? inlineUserText(v.issuerDisplayName) : '';
        const who = [issuerName, v.issuerHandle ? `(@${v.issuerHandle})` : '']
          .filter(Boolean)
          .join(' ');
        lines.push(
          `- Issued by ${who ? `${who} ` : ''}\`${v.issuer}\` · isValid: ${v.isValid} · created ${v.createdAt} · \`${v.uri}\``,
        );
      }
    }
    return [{ type: 'text', text: closeQuotes(lines).join('\n') }];
  },
});

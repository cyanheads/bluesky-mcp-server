/**
 * @fileoverview Read public Bluesky lists, starter packs, and their membership.
 * @module mcp-server/tools/definitions/bsky-get-list
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { destinationLink, quoteUserText } from '@/mcp-server/tools/post-format.js';
import { clampReadLimit, composeNotices, readLimitSchema } from '@/mcp-server/tools/read-limits.js';
import {
  ACTOR_REF_MESSAGE,
  ACTOR_REF_REGEX,
  actorFromRef,
  LIST_REF_MESSAGE,
  LIST_REF_REGEX,
} from '@/services/bluesky/at-syntax.js';
import { getBlueskyService, UNCONFIRMED_ACTOR_NOTICE } from '@/services/bluesky/bluesky-service.js';
import {
  type CollectionResult,
  isListUri,
  ListMember,
  ListMetadata,
  StarterPackMetadata,
} from '@/services/bluesky/collection-records.js';

const CollectionOutput = z.object({
  list: ListMetadata.optional().describe(
    'Requested list metadata, or the starter pack’s backing list metadata.',
  ),
  starterPack: StarterPackMetadata.optional().describe('Requested starter pack metadata.'),
  members: z
    .array(ListMember)
    .optional()
    .describe(
      'Membership records on this page. Absent if membership is unavailable or this is a discovery page.',
    ),
  lists: z
    .array(ListMetadata)
    .optional()
    .describe('Lists on this discovery page. The notice counts any this server could not read.'),
  starterPacks: z
    .array(StarterPackMetadata)
    .optional()
    .describe(
      'Starter packs on this discovery page. The notice counts any this server could not read.',
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      'Opaque cursor as supplied by Bluesky. Reuse a nonempty value with the same list or actor and kind, even after an empty page. An empty or absent cursor ends pagination.',
    ),
});

/**
 * Quote a JSON string as literal text. Its visible escapes preserve line breaks and whitespace,
 * and the framing prevents author text from contributing Markdown structure or links.
 */
function literal(value: string): string {
  return JSON.stringify(value).replace(/[\\`*_~[\]<&]/g, (character) => {
    if (character === '<') return '&lt;';
    if (character === '&') return '&amp;';
    return `\\${character}`;
  });
}

type Identity = z.infer<typeof ListMember>['subject'];

function renderUserField(label: string, value: string): string[] {
  const needsEscapes =
    value.includes('\r') ||
    value.includes('\0') ||
    value.split('\n').some((line) => line === '' || line.trim() !== line || line.startsWith('>'));
  return needsEscapes
    ? [`**${label} (JSON string):**`, `> ${literal(value)}`]
    : [`**${label}:**`, ...quoteUserText(value)];
}

function renderIdentity(label: string, identity: Identity): string[] {
  return [
    `**${label}:** ${literal(identity.handle)} · ${literal(identity.did)}`,
    ...(identity.displayName === undefined
      ? []
      : [...renderUserField('Display name', identity.displayName), '']),
  ];
}

function renderList(list: z.infer<typeof ListMetadata>): string[] {
  return [
    '### List',
    `**URI:** ${destinationLink(list.uri)}`,
    ...renderIdentity('Creator', list.creator),
    `**Purpose:** ${literal(list.purpose)}`,
    ...(list.listItemCount === undefined
      ? []
      : [`**Reported member count:** ${list.listItemCount}`]),
    ...renderUserField('Name', list.name),
    ...(list.description === undefined
      ? []
      : ['', ...renderUserField('Description', list.description)]),
    '',
  ];
}

function renderStarterPack(pack: z.infer<typeof StarterPackMetadata>): string[] {
  return [
    '### Starter pack',
    `**URI:** ${destinationLink(pack.uri)}`,
    ...renderIdentity('Creator', pack.creator),
    // A reference that is not a list AT-URI is shown as the literal text Bluesky sent, never a link.
    isListUri(pack.listUri)
      ? `**Backing list:** ${destinationLink(pack.listUri)}`
      : `**Backing list reference (not a list AT-URI):** ${literal(pack.listUri)}`,
    ...(pack.joinedWeekCount === undefined ? [] : [`**Joins this week:** ${pack.joinedWeekCount}`]),
    ...(pack.joinedAllTimeCount === undefined
      ? []
      : [`**All-time joins:** ${pack.joinedAllTimeCount}`]),
    ...(pack.feeds === undefined
      ? []
      : [
          pack.feeds.length === 0 ? '**Feeds:** (empty)' : '**Feeds:**',
          ...pack.feeds.map(({ feedUri }) => `- ${destinationLink(feedUri)}`),
        ]),
    ...renderUserField('Name', pack.name),
    ...(pack.description === undefined
      ? []
      : ['', ...renderUserField('Description', pack.description)]),
    '',
  ];
}

/** Why a starter pack's membership is unavailable, by what became of its backing list reference. */
const MEMBERSHIP_UNAVAILABLE = {
  notFound:
    'Starter pack membership is unavailable because Bluesky could not find its backing list.',
  unreadable:
    'Starter pack membership is unavailable because its backing list reference could not be read.',
} as const satisfies Record<
  Extract<CollectionResult, { kind: 'missingBackingList' }>['backingList'],
  string
>;

/** Read one public collection or page one kind of collection for an actor. */
export const bskyGetList = tool('bsky_get_list', {
  title: 'Get Bluesky List or Starter Pack',
  description:
    'Read a Bluesky list or starter pack with list, or discover one actor’s public lists or starter packs with actor and kind. Direct reads return metadata and one membership page. To read posts, pass a list URI or a starter pack feedUri to bsky_get_feed.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.strictObject({
    list: z
      .string()
      .max(2048)
      .regex(LIST_REF_REGEX, LIST_REF_MESSAGE)
      .optional()
      .describe('List or starter pack AT-URI or bsky.app page. Use for a direct membership read.'),
    actor: z
      .string()
      .max(2048)
      .regex(ACTOR_REF_REGEX, ACTOR_REF_MESSAGE)
      .optional()
      .describe(
        'Handle, @handle, DID, or bsky.app profile URL. Use with kind to discover collections.',
      ),
    kind: z
      .enum(['lists', 'starterPacks'])
      .optional()
      .describe('Collection to discover for actor. Required with actor. Omit with list.'),
    limit: readLimitSchema(100)
      .default(25)
      .describe(
        'Maximum members or discovery results to return. Default 25. Values above 100 are clamped unless read-limit clamping is disabled.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Nonempty opaque cursor from a previous page of the same list or the same actor and kind.',
      ),
  }),
  output: CollectionOutput,
  enrichment: {
    totalReturned: z
      .number()
      .optional()
      .describe(
        'Number of members, lists, or starter packs on this page, 0 included. Absent when starter pack membership is unavailable.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'The limit clamp, when the limit was clamped, then at most one page notice. A discovery page that left out lists or starter packs this server could not read opens its page notice with how many. A page with a cursor says to pass it with the same list, starter pack, or actor and kind, even after an empty page. An empty page without a cursor that left nothing out says the previous page was the last when the call carried a cursor, and that nothing was found otherwise; for a DID, it adds that Bluesky did not confirm the account exists when its profile check could not finish. Any other page without a cursor gets no page notice beyond what it left out. When starter pack membership is unavailable, the reason replaces the page notice: Bluesky could not find the backing list, or the backing list reference could not be read.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when Bluesky supplied a nonempty continuation cursor, whatever this page held.',
      ),
    shown: z.number().optional().describe('Number of members or discovery results on this page.'),
    cap: z.number().optional().describe('Limit applied to this page.'),
  },
  errors: [
    {
      reason: 'invalid_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The arguments do not select exactly one collection mode.',
      recovery: 'Use list by itself, or provide actor together with kind.',
    },
    {
      reason: 'list_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested list does not exist or its owner handle does not resolve.',
      recovery: 'Check the list AT-URI or discover the owner’s lists with actor and kind lists.',
      thrownBy: 'service',
    },
    {
      reason: 'starter_pack_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested starter pack does not exist or its owner handle does not resolve.',
      recovery:
        'Check the starter pack AT-URI or discover the owner’s packs with actor and kind starterPacks.',
      thrownBy: 'service',
    },
    {
      reason: 'actor_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Bluesky could not find the actor’s profile, or rejected the actor as an invalid identifier.',
      recovery:
        'Verify the handle or DID with bsky_get_profile or find the account with bsky_search_actors.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { applied: limit, notice: clampNotice } = clampReadLimit(
      ctx,
      'bsky_get_list',
      'limit',
      input.limit,
      100,
    );
    const page = { limit, cursor: input.cursor };
    const service = getBlueskyService();
    let result: CollectionResult;
    // How the page notices name what this read continues (`target`) and what it pages (`noun`).
    let terms: { target: string; noun: string; none: string };
    // The page-notice clause for discovery rows Bluesky sent that this server could not read.
    let omitted: string | undefined;
    if (input.list !== undefined && input.actor === undefined && input.kind === undefined) {
      result = await service.getList({ list: input.list, ...page }, ctx);
      terms =
        result.kind === 'list'
          ? { target: 'list', noun: 'members', none: 'No members found on this list.' }
          : {
              target: 'starter pack',
              noun: 'members',
              none: 'No members found on this starter pack’s list.',
            };
    } else if (input.list === undefined && input.actor !== undefined && input.kind !== undefined) {
      const discovered = await service.discoverCollections(
        { actor: input.actor, kind: input.kind, ...page },
        ctx,
      );
      result = discovered;
      const [one, noun] =
        input.kind === 'lists' ? ['list', 'lists'] : ['starter pack', 'starter packs'];
      terms = {
        target: 'actor and kind',
        noun,
        none: `No ${noun} found for actor "${actorFromRef(input.actor)}".`,
      };
      const count = discovered.unreadable;
      if (count) {
        omitted = `${count} ${count === 1 ? one : noun} Bluesky sent on this page could not be read and ${count === 1 ? 'is' : 'are'} left out.`;
      }
    } else {
      throw ctx.fail('invalid_mode');
    }
    if (result.kind === 'missingBackingList') {
      ctx.enrich.notice(composeNotices(clampNotice, MEMBERSHIP_UNAVAILABLE[result.backingList]));
      return { starterPack: result.starterPack };
    }
    const shown = (
      result.kind === 'lists'
        ? result.lists
        : result.kind === 'starterPacks'
          ? result.starterPacks
          : result.members
    ).length;
    ctx.enrich({ totalReturned: shown });
    if (result.cursor) {
      ctx.enrich.truncated({
        shown,
        cap: limit,
        guidance: composeNotices(
          clampNotice,
          omitted,
          `Pass the returned cursor with the same ${terms.target} to fetch the next page of ${terms.noun}, even after an empty page.`,
        ),
      });
    } else {
      // A page that left rows out was not empty when Bluesky sent it: it gets no empty-page wording.
      const notice = composeNotices(
        clampNotice,
        omitted ??
          (shown === 0
            ? composeNotices(
                input.cursor
                  ? `No more ${terms.noun} — the previous page was the last.`
                  : terms.none,
                'actorUnconfirmed' in result ? UNCONFIRMED_ACTOR_NOTICE : undefined,
              )
            : undefined),
      );
      if (notice) ctx.enrich.notice(notice);
    }
    const { kind: _kind, ...output } = result;
    if ('actorUnconfirmed' in output) delete output.actorUnconfirmed;
    if ('unreadable' in output) delete output.unreadable;
    return output;
  },

  format(result) {
    const lines: string[] = [];
    if (result.starterPack) lines.push(...renderStarterPack(result.starterPack));
    if (result.list) lines.push(...renderList(result.list));
    if (result.members) {
      lines.push('### Members');
      if (result.members.length === 0) lines.push('No members on this page.');
      for (const member of result.members) {
        lines.push(
          `**Membership:** ${destinationLink(member.uri)}`,
          ...renderIdentity('Account', member.subject),
          '',
        );
      }
    }
    if (result.lists) {
      if (result.lists.length === 0) lines.push('No lists on this page.');
      for (const list of result.lists) lines.push(...renderList(list));
    }
    if (result.starterPacks) {
      if (result.starterPacks.length === 0) lines.push('No starter packs on this page.');
      for (const pack of result.starterPacks) lines.push(...renderStarterPack(pack));
    }
    if (result.cursor !== undefined) lines.push(`**Cursor:** ${literal(result.cursor)}`);
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

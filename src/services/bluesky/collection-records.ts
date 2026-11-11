/**
 * @fileoverview AppView collection response schemas and public list and starter pack projections.
 * @module services/bluesky/collection-records
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  AT_URI_REF_REGEX,
  FEED_REF_REGEX,
  LIST_COLLECTION,
  LIST_REF_REGEX,
  STARTER_PACK_COLLECTION,
} from './at-syntax.js';

const Identity = z.object({
  did: z.string().describe('Permanent DID of the account.'),
  handle: z.string().describe('Public handle of the account.'),
  displayName: z.string().optional().describe('Display name supplied by the account.'),
});

/** Metadata for a list as returned in detail and discovery responses. */
export const ListMetadata = z
  .object({
    uri: z.string().describe('List AT-URI. Use with bsky_get_list or bsky_get_feed.'),
    name: z.string().describe('Name supplied by the list creator.'),
    creator: Identity.describe('Account that created the list.'),
    purpose: z.string().describe('List purpose as reported by Bluesky, including future values.'),
    description: z.string().optional().describe('Description supplied by the list creator.'),
    listItemCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Bluesky’s reported member count across the list.'),
  })
  .describe('Metadata for a Bluesky graph list.');

/** A list membership with the public identity of its subject. */
export const ListMember = z
  .object({
    uri: z.string().describe('AT-URI of the membership record.'),
    subject: Identity.describe('Account in the list. Use its DID or handle with bsky_get_profile.'),
  })
  .describe('One list membership record and its account.');

/** Starter pack metadata projected from its record and the AppView counts. */
export const StarterPackMetadata = z
  .object({
    uri: z.string().describe('Starter pack AT-URI. Use with bsky_get_list.'),
    name: z.string().describe('Name supplied by the starter pack creator.'),
    creator: Identity.describe('Account that created the starter pack.'),
    description: z
      .string()
      .optional()
      .describe('Description supplied by the starter pack creator.'),
    joinedWeekCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Joins in the past week as reported by Bluesky.'),
    joinedAllTimeCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('All-time joins as reported by Bluesky.'),
    listUri: z
      .string()
      .describe('AT-URI of the backing list. Use with bsky_get_list or bsky_get_feed.'),
    feeds: z
      .array(
        z
          .object({
            feedUri: z.string().describe('Generator AT-URI to pass to bsky_get_feed.'),
          })
          .describe('A feed reference supplied for the starter pack.'),
      )
      .optional()
      .describe('Feed references supplied for the starter pack.'),
  })
  .describe('Metadata for a Bluesky starter pack.');

const listUri = z
  .string()
  .startsWith('at://')
  .regex(LIST_REF_REGEX)
  .includes(`/${LIST_COLLECTION}/`);
const starterPackUri = z
  .string()
  .startsWith('at://')
  .regex(LIST_REF_REGEX)
  .includes(`/${STARTER_PACK_COLLECTION}/`);
const generatorUri = z.string().startsWith('at://').regex(FEED_REF_REGEX);
const listView = ListMetadata.extend({ uri: listUri });
const starterPackView = StarterPackMetadata.pick({
  uri: true,
  creator: true,
  joinedWeekCount: true,
  joinedAllTimeCount: true,
})
  .extend({
    uri: starterPackUri,
    record: z.object({
      list: listUri,
      name: z.string(),
      description: z.string().optional(),
      feeds: z.array(z.object({ uri: generatorUri })).optional(),
    }),
    list: z.object({ uri: listUri }).optional(),
    feeds: z.array(z.object({ uri: generatorUri })).optional(),
  })
  .transform(({ record, list, feeds, ...view }) => {
    const feedUris =
      record.feeds === undefined && feeds === undefined
        ? undefined
        : [...new Set([...(record.feeds ?? []), ...(feeds ?? [])].map(({ uri }) => uri))];
    return {
      ...view,
      listUri: list?.uri ?? record.list,
      name: record.name,
      ...(record.description !== undefined ? { description: record.description } : {}),
      ...(feedUris !== undefined ? { feeds: feedUris.map((feedUri) => ({ feedUri })) } : {}),
    };
  });

/** Pageable detail from getList. */
export const ListPage = z.object({
  list: listView,
  items: z.array(
    ListMember.extend({ uri: z.string().startsWith('at://').regex(AT_URI_REF_REGEX) }),
  ),
  cursor: z.string().optional(),
});

/** List discovery from getLists. */
export const ListDiscoveryPage = z.object({
  lists: z.array(listView),
  cursor: z.string().optional(),
});

/** Starter pack detail from getStarterPack. */
export const StarterPackView = z.object({ starterPack: starterPackView });

/** Starter pack discovery from getActorStarterPacks. */
export const StarterPackDiscoveryPage = z.object({
  starterPacks: z.array(starterPackView),
  cursor: z.string().optional(),
});

/** Public collection selector for actor discovery. */
export type CollectionKind = 'lists' | 'starterPacks';

/** Result of a direct collection read or one page of actor discovery. */
export type CollectionResult =
  | { kind: 'lists'; lists: z.infer<typeof ListMetadata>[]; cursor?: string | undefined }
  | {
      kind: 'starterPacks';
      starterPacks: z.infer<typeof StarterPackMetadata>[];
      cursor?: string | undefined;
    }
  | {
      kind: 'list';
      list: z.infer<typeof ListMetadata>;
      members: z.infer<typeof ListMember>[];
      cursor?: string | undefined;
    }
  | {
      kind: 'starterPack';
      starterPack: z.infer<typeof StarterPackMetadata>;
      list: z.infer<typeof ListMetadata>;
      members: z.infer<typeof ListMember>[];
      cursor?: string | undefined;
    }
  | { kind: 'missingBackingList'; starterPack: z.infer<typeof StarterPackMetadata> };

/**
 * @fileoverview Rich-text facet schema shared by post tools; offsets address the unchanged UTF-8 text.
 * @module services/bluesky/post-facets
 */
import { z } from '@cyanheads/mcp-ts-core';

/** @internal Known feature types retain their required, typed fields and any forward fields. */
const KnownFeatureSchema = z.discriminatedUnion('$type', [
  z
    .object({
      $type: z.literal('app.bsky.richtext.facet#link').describe('Link feature.'),
      uri: z
        .string()
        .describe('Complete destination URI, independent of abbreviated display text.'),
    })
    .passthrough()
    .describe('Link destination.'),
  z
    .object({
      $type: z.literal('app.bsky.richtext.facet#mention').describe('Mention feature.'),
      did: z.string().describe('Mentioned account DID.'),
    })
    .passthrough()
    .describe('Mention identity.'),
  z
    .object({
      $type: z.literal('app.bsky.richtext.facet#tag').describe('Tag feature.'),
      tag: z.string().describe('Tag text without the leading hash.'),
    })
    .passthrough()
    .describe('Tag value.'),
]);

const knownFeatureTypes = new Set<string>(
  KnownFeatureSchema.options.map((schema) => schema.shape.$type.value),
);

/** @internal Open-union variants cannot act as a fallback for malformed known features. */
const OtherFeatureSchema = z
  .object({
    $type: z
      .string()
      .refine(
        (type) => !knownFeatureTypes.has(type),
        'Known feature types must satisfy their declared fields.',
      )
      .describe('An upstream feature type other than the known link, mention, or tag types.'),
  })
  .passthrough()
  .describe('An open-union feature whose complete fields are retained as literal metadata.');

/** Facet metadata, separate from the original post text. */
export const FacetSchema = z
  .object({
    index: z
      .object({
        byteStart: z
          .number()
          .int()
          .nonnegative()
          .describe('Inclusive UTF-8 byte offset in the original text.'),
        byteEnd: z
          .number()
          .int()
          .nonnegative()
          .describe('Exclusive UTF-8 byte offset in the original text.'),
      })
      .passthrough()
      .describe(
        'UTF-8 byte range; these are not JavaScript string indices. Additional upstream fields are retained.',
      ),
    features: z
      .array(
        z
          .union([...KnownFeatureSchema.options, OtherFeatureSchema])
          .describe('A known link, mention, or tag feature, or an upstream extension variant.'),
      )
      .describe('Features applied to this range, in upstream order.'),
  })
  .passthrough()
  .describe('One rich-text annotation on the original post text.');

/** A facet retains its upstream feature discriminants and byte offsets. */
export type PostFacet = z.infer<typeof FacetSchema>;

/** Return a typed known feature; unknown variants stay metadata, while malformed known fields throw. */
export function knownFacetFeature(feature: PostFacet['features'][number]) {
  if (!knownFeatureTypes.has(feature.$type)) return;
  return KnownFeatureSchema.parse(feature);
}

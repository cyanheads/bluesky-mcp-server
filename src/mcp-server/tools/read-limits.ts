/**
 * @fileoverview Shared read-limit schema policy and per-call clamp disclosure.
 * @module mcp-server/tools/read-limits
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getClampReadLimits } from '@/config/server-config.js';

/** A plain number schema preserves the framework's numeric-string representation repair. */
export function readLimitSchema(maximum: number, minimum = 1): z.ZodNumber {
  const schema = z.number().int().min(minimum);
  return getClampReadLimits() ? schema : schema.max(maximum);
}

type ReadTool =
  | 'bsky_get_author_feed'
  | 'bsky_get_feed'
  | 'bsky_get_follows'
  | 'bsky_get_post_quotes'
  | 'bsky_search_actors'
  | 'bsky_search_feeds'
  | 'bsky_search_posts'
  | 'bsky_get_trending'
  | 'bsky_get_post_thread';
type ReadField = 'limit' | 'depth' | 'parent_height';

let clampedFields: ReturnType<typeof createCounter> | undefined;

/** Clamp once before upstream work; callers include the notice when measuring their response. */
export function clampReadLimit(
  ctx: Context,
  tool: ReadTool,
  field: ReadField,
  requested: number,
  maximum: number,
): { applied: number; notice?: string } {
  const applied = Math.min(requested, maximum);
  if (applied === requested) return { applied };
  ctx.log.info('Clamped Bluesky read limit', { tool, field, requested, applied });
  clampedFields ??= createCounter(
    'bluesky.read_limit.clamped',
    'Read fields clamped to their existing maximum',
  );
  clampedFields.add(1, { tool, field });
  return { applied, notice: `${field} ${requested} requested; ${applied} applied.` };
}

/** Compose the single last-wins notice without replacing page or budget recovery guidance. */
export function composeNotices(...notices: Array<string | undefined>): string {
  return notices.filter(Boolean).join(' ');
}

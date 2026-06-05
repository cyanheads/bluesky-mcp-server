/**
 * @fileoverview Fetch a full Bluesky post conversation thread by AT-URI.
 * @module mcp-server/tools/definitions/bsky-get-post-thread
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type { ThreadPost } from '@/services/bluesky/types.js';

/** @internal Recursively format a thread tree into readable markdown lines. */
function formatThreadNode(node: ThreadPost, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  if (node.notFound) {
    lines.push(`${indent}*[Post not found or deleted]*`);
    return;
  }
  if (node.truncated) {
    lines.push(`${indent}*[More replies — use a deeper depth to load them]*`);
    return;
  }
  const p = node.post;
  const author = p.author.displayName
    ? `${p.author.displayName} (@${p.author.handle})`
    : `@${p.author.handle}`;
  lines.push(`${indent}### ${author}`);
  lines.push(`${indent}**AT-URI:** \`${p.uri}\``);
  lines.push(`${indent}${p.text}`);
  const meta: string[] = [];
  if (p.likeCount != null) meta.push(`${p.likeCount} likes`);
  if (p.repostCount != null) meta.push(`${p.repostCount} reposts`);
  if (p.replyCount != null) meta.push(`${p.replyCount} replies`);
  if (meta.length) lines.push(`${indent}*${meta.join(' · ')}*`);
  if (p.createdAt) lines.push(`${indent}*${p.createdAt}*`);
  if (p.labels?.length) lines.push(`${indent}**Labels:** ${p.labels.map((l) => l.val).join(', ')}`);
  if (node.replies?.length) {
    lines.push(`${indent}---`);
    for (const reply of node.replies) {
      formatThreadNode(reply, depth + 1, lines);
    }
  }
}

/**
 * Thread node schema — uses passthrough so all post fields (uri, cid, text, author, engagement counts,
 * createdAt, labels, embed, replyToUri) and thread structure (parent, replies, truncated, notFound)
 * flow through structuredContent without format-parity constraints on the recursive tree shape.
 */
const ThreadNodeSchema: z.ZodType<unknown> = z
  .object({})
  .passthrough()
  .describe(
    'Recursive thread node. Each node has: ' +
      'post: { uri, cid, text, author: { did, handle, displayName?, avatar? }, replyCount?, repostCount?, likeCount?, quoteCount?, indexedAt?, createdAt?, labels?, embed?, replyToUri? }. ' +
      'parent?: parent thread node. replies?: array of child thread nodes. ' +
      'truncated?: true when the API cut off deeper replies. notFound?: true when the post was deleted.',
  );

export const bskyGetPostThread = tool('bsky_get_post_thread', {
  title: 'Get Bluesky Post Thread',
  description:
    'Fetch the full conversation for a post by AT-URI — the parent chain upward and the reply tree downward. ' +
    'Enter the thread at any point and traverse the full discussion. ' +
    'AT-URIs have the format "at://<did>/<collection>/<rkey>" and are returned by bsky_search_posts and ' +
    'bsky_get_author_feed in the "uri" field of each post. ' +
    'Returns the root post, parent chain, and nested replies with per-post author and engagement data. ' +
    '"truncated: true" on a reply node means there are more replies below — increase depth to load them.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    uri: z
      .string()
      .describe(
        'AT-URI of the post to fetch, e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/abc123". ' +
          'Obtain from bsky_search_posts or bsky_get_author_feed.',
      ),
    depth: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(6)
      .describe('How many levels of replies to include in the reply tree. Default 6.'),
    parent_height: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(80)
      .describe(
        'How many parent posts to include in the parent chain above the target post. Default 80.',
      ),
  }),
  output: z.object({
    thread: ThreadNodeSchema.describe('The conversation thread rooted at the requested post.'),
  }),

  errors: [
    {
      reason: 'invalid_at_uri',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The uri parameter is not a valid AT-URI (at://<did>/<collection>/<rkey>).',
      recovery:
        'AT-URIs come from the "uri" field of posts returned by bsky_search_posts or bsky_get_author_feed.',
    },
    {
      reason: 'post_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The AT-URI is valid format but the post was deleted or never existed.',
      recovery: 'Verify the AT-URI or use bsky_search_posts to find the correct post.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Fetching Bluesky post thread', { uri: input.uri, depth: input.depth });

    // Validate AT-URI format before hitting the API
    if (!input.uri.startsWith('at://')) {
      throw ctx.fail('invalid_at_uri', `Invalid AT-URI: "${input.uri}" must start with "at://"`, {
        ...ctx.recoveryFor('invalid_at_uri'),
      });
    }

    let thread: ThreadPost;
    try {
      thread = await getBlueskyService().getPostThread(
        { uri: input.uri, depth: input.depth, parentHeight: input.parent_height },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const body = (err.data as { responseBody?: string } | undefined)?.responseBody ?? '';
        if (
          err.data &&
          (body.includes('NotFound') ||
            body.includes('not found') ||
            body.includes('Not Found') ||
            body.includes('Post not found'))
        ) {
          throw ctx.fail('post_not_found', `Post not found: "${input.uri}"`, {
            ...ctx.recoveryFor('post_not_found'),
          });
        }
      }
      throw err;
    }

    return { thread };
  },

  format: (result) => {
    const thread = result.thread as ThreadPost;
    if (!thread || thread.notFound) {
      return [{ type: 'text', text: '*Post not found or deleted.*' }];
    }
    const lines: string[] = ['# Thread'];
    // Render parent chain first (walking up)
    if (thread.parent) {
      lines.push('## Parent chain');
      const parents: ThreadPost[] = [];
      let cur: ThreadPost | undefined = thread.parent;
      while (cur) {
        parents.unshift(cur);
        cur = cur.parent;
      }
      for (const p of parents) {
        const { replies: _r, ...pWithoutReplies } = p;
        formatThreadNode(pWithoutReplies, 0, lines);
        lines.push('');
      }
      lines.push('---');
    }
    lines.push('## This post');
    const { parent: _p, ...threadWithoutParent } = thread;
    formatThreadNode(threadWithoutParent, 0, lines);
    if (thread.replies?.length) {
      lines.push('');
      lines.push('## Replies');
      for (const reply of thread.replies) {
        formatThreadNode(reply, 0, lines);
        lines.push('');
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

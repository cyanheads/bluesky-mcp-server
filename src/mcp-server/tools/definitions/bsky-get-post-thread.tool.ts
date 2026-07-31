/**
 * @fileoverview Fetch a Bluesky post conversation thread by AT-URI, disclosing both ways the
 * response falls short of the conversation: how far the AppView's reply counts run ahead of the
 * replies it returned, and whether the parent chain stopped at the requested height rather than at
 * the start of the thread. Reply depth rides the author heading rather than the left margin, so no
 * line of a nested node crosses the four-space threshold that would turn it into a code block.
 * @module mcp-server/tools/definitions/bsky-get-post-thread
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { renderPostLines } from '@/mcp-server/tools/post-format.js';
import { AT_URI_MESSAGE, AT_URI_REGEX } from '@/services/bluesky/at-syntax.js';
import { getBlueskyService } from '@/services/bluesky/bluesky-service.js';
import type {
  PostThreadResult,
  ThreadGate,
  ThreadGateRule,
  ThreadPost,
} from '@/services/bluesky/types.js';

/**
 * Deepest reply tree `app.bsky.feed.getPostThread` will return, measured against the live
 * AppView: across 748 threads walked at `depth` 1000 — 94,366 nodes in all — no response ever
 * carried a reply below level 10, and a 1,805-reply thread came back byte-identical at `depth`
 * 10, 20, 50, and 1000 (365 nodes, 10 levels) while a re-rooted fetch proved the tree continued
 * below level 10. The AppView's own bound is 1000; 1001 is a hard `InvalidRequest`.
 */
const MAX_REPLY_DEPTH = 10;

/**
 * Ceiling for the parent chain. Unlike the reply tree, the AppView honors `parentHeight` level
 * for level up to its own maximum of 1000, so the bound is ours to set: sampling 244 live replies
 * put the median chain at 1 post and the 99th percentile at 96, and each level costs roughly
 * 1.5 KB upstream. Chains longer than this exist — the longest sampled ran 645 posts — and are
 * read by re-rooting a request at the topmost parent returned.
 */
const MAX_PARENT_HEIGHT = 100;

/** @internal "1 reply" / "N replies". */
function replyCountLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'reply' : 'replies'}`;
}

/** @internal The line that discloses how far a node's reply count runs ahead of its replies. */
function truncationLine(node: ThreadPost): string {
  const n = node.unreturnedReplies ?? 0;
  const count = replyCountLabel(n);
  return node.truncationReason === 'unavailable'
    ? `*[Bluesky counts ${count} to this post that it did not return — held back past its per-post limit, or gone from the index and never subtracted from the count. No request retrieves them]*`
    : `*[${count} below this post ${n === 1 ? 'was' : 'were'} not returned — the reply tree ends at this level; fetch this post's AT-URI with bsky_get_post_thread to read them]*`;
}

/** @internal The line that discloses that the parent chain stops short of the conversation root. */
function parentChainLine(node: ThreadPost): string {
  return `*[Not the start of the conversation — the parent chain stops here at the requested parent_height, and this post replies to \`${node.post.replyToUri}\`, which is not in this response. Fetch this post's AT-URI with bsky_get_post_thread to continue upward]*`;
}

/**
 * @internal How a reply's depth is shown. It rides the author heading rather than the left margin:
 * indenting two spaces per level put every line of a node at depth 2 or below past four leading
 * spaces, which CommonMark reads as an indented code block — turning headings, blockquotes, and the
 * truncation notices of the whole nested half of a thread into literal preformatted text. The
 * detail lines under an embed already sit at the three-space limit, so the margin has no room left
 * to carry depth as well.
 *
 * The number is written out rather than repeated as a glyph. A reply can sit nine levels below the
 * one it descends from, and a run of nine identical arrows has to be counted to be read — the same
 * failure as an indent, one channel over.
 */
function depthMarker(depth: number): string {
  return depth > 0 ? `↳${depth} ` : '';
}

/** @internal Recursively format a thread tree into readable markdown lines. */
function formatThreadNode(node: ThreadPost, depth: number, lines: string[]): void {
  const marker = depthMarker(depth);
  const uriSuffix = node.post.uri ? ` \`${node.post.uri}\`` : '';
  if (node.notFound) {
    lines.push(`${marker}*[Post not found or deleted]*${uriSuffix}`);
    return;
  }
  if (node.blocked) {
    lines.push(`${marker}*[Post hidden — its author blocks this view]*${uriSuffix}`);
    return;
  }
  /** Above the node it belongs to, since the posts it names sit above it in the conversation. */
  if (node.parentChainTruncated) {
    lines.push(`${marker}${parentChainLine(node)}`);
  }
  lines.push(...renderPostLines(node.post, marker));
  /**
   * A blank line before each child: without it a `---` or an emphasis line would attach to the
   * paragraph above and render as a setext heading rather than as its own block.
   */
  for (const reply of node.replies ?? []) {
    lines.push('');
    formatThreadNode(reply, depth + 1, lines);
  }
  /**
   * Blank-line separated for the same reason: an emphasis line following the post body directly
   * would be read as a continuation of the blockquote it sits under rather than as its own note.
   */
  if (node.truncated) {
    lines.push('', `${marker}${truncationLine(node)}`);
  }
}

/** What a walk of the normalized thread found. */
interface ThreadSurvey {
  /** Replies the thread author hid that are absent from the tree — a named part of the shortfall. */
  authorHidden: number;
  /** Nodes reached at the edge of the reply tree with replies still below them. */
  depthLimitedNodes: number;
  /** Every node in the response — the target, its parent chain, and every reply. */
  nodes: number;
  /**
   * AT-URI of the topmost node returned in the parent direction when the chain was cut there.
   * Empty when the chain reached the conversation root, which is the ordinary case.
   */
  parentChainTopUri: string;
  /** Nodes whose missing replies no further request can reach. */
  unavailableNodes: number;
  /** How far the AppView's reply counts run ahead of the replies returned, totalled. */
  unreturnedReplies: number;
}

/**
 * @internal Walk the normalized thread and total up what came back and what did not. The gate's
 * `hiddenReplies` are matched against the URIs actually returned, so only the hidden replies that
 * are genuinely absent count toward the explained part of the shortfall — the AppView leaves some
 * of them in the tree.
 */
function surveyThread(thread: ThreadPost, gate: ThreadGate | undefined): ThreadSurvey {
  const survey: ThreadSurvey = {
    authorHidden: 0,
    depthLimitedNodes: 0,
    nodes: 0,
    parentChainTopUri: '',
    unavailableNodes: 0,
    unreturnedReplies: 0,
  };
  const returned = new Set<string>();
  const visit = (node: ThreadPost): void => {
    survey.nodes++;
    if (node.post.uri) returned.add(node.post.uri);
    if (node.parentChainTruncated) survey.parentChainTopUri = node.post.uri;
    if (node.truncated) {
      survey.unreturnedReplies += node.unreturnedReplies ?? 0;
      if (node.truncationReason === 'unavailable') survey.unavailableNodes++;
      else survey.depthLimitedNodes++;
    }
    if (node.parent) visit(node.parent);
    for (const reply of node.replies ?? []) visit(reply);
  };
  visit(thread);
  survey.authorHidden = (gate?.hiddenReplies ?? []).filter((uri) => !returned.has(uri)).length;
  return survey;
}

/** @internal "1 post" / "N posts". */
function postCountLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'post' : 'posts'}`;
}

/**
 * @internal Spell out what the response is missing and which part of it is still reachable.
 * Two independent shortfalls feed it — the reply tree below the target and the parent chain above —
 * and either alone is enough to make the notice worth sending.
 */
function truncationNotice(survey: ThreadSurvey): string {
  const parts: string[] = [];
  if (survey.unreturnedReplies > 0) {
    parts.push(
      `This thread is partial — Bluesky's reply counts run ${replyCountLabel(survey.unreturnedReplies)} ahead of what it returned.`,
    );
    if (survey.depthLimitedNodes > 0) {
      parts.push(
        `${postCountLabel(survey.depthLimitedNodes)} ${survey.depthLimitedNodes === 1 ? 'sits' : 'sit'} at the edge of the reply tree — call bsky_get_post_thread with such a post's AT-URI to read below it.`,
      );
    }
    if (survey.unavailableNodes > 0) {
      parts.push(
        `On ${postCountLabel(survey.unavailableNodes)} the difference is not retrievable by any request: Bluesky holds replies back past a per-post limit, and its counts also keep including replies that have left the index, so treat the number as an upper bound on what is missing rather than a count of readable replies.`,
      );
    }
    if (survey.authorHidden > 0) {
      parts.push(
        `${replyCountLabel(survey.authorHidden)} in that difference ${survey.authorHidden === 1 ? 'is' : 'are'} accounted for: the thread author hid ${survey.authorHidden === 1 ? 'it' : 'them'}.`,
      );
    }
  }
  if (survey.parentChainTopUri) {
    parts.push(
      `The conversation also continues above what was returned: the topmost post in the parent chain, \`${survey.parentChainTopUri}\`, is itself a reply, so it is not the start of the thread. This part is fully recoverable — unlike the reply shortfall, parent_height is honored level for level, so calling bsky_get_post_thread with that AT-URI walks further up.`,
    );
  }
  parts.push('Treat any summary of this conversation as covering only what was returned.');
  return parts.join(' ');
}

/**
 * @internal The threadgate as it reaches `format()`. Distinct from `ThreadGate` only in that the
 * output schema hands optional fields over explicitly undefined rather than absent.
 */
interface ThreadGateView {
  allow?: ThreadGateRule[] | undefined;
  hiddenReplies: string[];
  uri: string;
}

/** @internal The threadgate block that opens the rendered thread. */
function renderGateLines(gate: ThreadGateView): string[] {
  const hidden = gate.hiddenReplies;
  const lines = [`> 🔒 ${gateAudience(gate)}. Threadgate: \`${gate.uri}\``];
  if (hidden.length > 0) {
    lines.push(
      `> ${replyCountLabel(hidden.length)} hidden by the thread author: ${hidden.map((uri) => `\`${uri}\``).join(', ')}`,
    );
  }
  lines.push('');
  return lines;
}

/** @internal Plain-language name for each threadgate rule. */
const GATE_AUDIENCE: Record<ThreadGateRule, string> = {
  follower: "the author's followers",
  following: 'accounts the author follows',
  list: 'members of a list the author chose',
  mentioned: 'accounts mentioned in the post',
  unknown: 'an audience this server does not recognize',
};

/** @internal Plain-language rendering of who a threadgate lets reply. */
function gateAudience(gate: ThreadGateView): string {
  if (!gate.allow) return 'Replies are open to anyone';
  if (gate.allow.length === 0) return 'Replies are turned off';
  return `Replies are limited to ${gate.allow.map((r) => GATE_AUDIENCE[r]).join(', ')}`;
}

/**
 * Thread node schema — uses passthrough so all post fields (uri, cid, text, author, engagement counts,
 * createdAt, labels, embed, replyToUri, replyRootUri) and thread structure (parent, replies, truncated,
 * truncationReason, unreturnedReplies, notFound, blocked) flow through structuredContent without
 * format-parity constraints on the recursive tree shape.
 *
 * Passthrough is why the node this describes must be normalized down to what it names: the sibling
 * tools declare their post shape as a closed object, so an extra field is stripped there and
 * survives here. The author fields listed below are the four the service carries and the four the
 * renderer emits — widening the normalized author again would put fields in this channel alone.
 */
const ThreadNodeSchema: z.ZodType<unknown> = z
  .object({})
  .passthrough()
  .describe(
    'The conversation thread rooted at the requested post — a recursive node tree. Each node has: ' +
      'post: { uri, cid, text, author: { did, handle, displayName?, avatar? }, replyCount?, repostCount?, likeCount?, quoteCount?, indexedAt?, createdAt?, labels?: [{ val, src?, cts? }], embed?, replyToUri?, replyRootUri? }. ' +
      'parent?: parent thread node. replies?: array of child thread nodes. ' +
      "truncated?: true when the node's own post.replyCount exceeds the replies returned for it, with " +
      'unreturnedReplies: the size of that difference, and truncationReason: "depth" (the reply tree ends ' +
      'at this node — fetch its post.uri as its own thread to continue below it) or "unavailable" (no ' +
      'request closes the gap). unreturnedReplies is an upper bound on what is missing, not a count of ' +
      "readable replies: Bluesky's counter keeps including replies that have left the index, so a node " +
      'reporting one unreturned reply often has none left to fetch. Only reply-tree nodes carry these; a ' +
      'parent-chain node is linear by construction and never reports a reply shortfall. ' +
      'parentChainTruncated?: true on the topmost node above the target when the chain stopped at ' +
      'parent_height rather than at the start of the conversation — that node is a reply to a post this ' +
      "response does not contain, so it is not the conversation root. Fetch that node's post.uri as its " +
      'own thread to continue upward; parent_height is honored level for level, so the ancestors above ' +
      'it are one request away. Set on the target itself when no parent was returned at all. ' +
      'notFound?: true when the post was deleted or never existed. blocked?: true when its author blocks ' +
      'this view. Both stubs carry the reported AT-URI on post.uri and no content — a blocked node also ' +
      'carries the author DID on post.author.did.',
  );

/** Reply restrictions the thread author set, when the AppView returned a threadgate. */
const ThreadGateSchema = z
  .object({
    uri: z.string().describe('AT-URI of the threadgate record itself.'),
    allow: z
      .array(z.enum(['follower', 'following', 'list', 'mentioned', 'unknown']))
      .optional()
      .describe(
        'Who may reply. Omitted when anyone may; an empty array means the author turned replies off. ' +
          'Replies posted before the rule was set stay in the thread.',
      ),
    hiddenReplies: z
      .array(z.string())
      .describe(
        'AT-URIs of replies the thread author hid. Some are still present in the returned tree — ' +
          'compare against the node URIs rather than assuming every entry is absent.',
      ),
  })
  .describe(
    "The thread author's reply restrictions, present only when they set one. Hidden replies are " +
      'counted in replyCount whether or not they were returned, so a gated thread is one reason the ' +
      'counts run ahead of the tree.',
  );

export const bskyGetPostThread = tool('bsky_get_post_thread', {
  title: 'Get Bluesky Post Thread',
  description:
    'Fetch the conversation for a post by AT-URI — the parent chain upward and the reply tree downward. ' +
    'Enter the thread at any point and traverse the discussion. ' +
    'AT-URIs have the format "at://<handle-or-did>/<collection>/<rkey>" and are returned by bsky_search_posts and ' +
    'bsky_get_author_feed in the "uri" field of each post. ' +
    'Returns the root post, parent chain, and nested replies with per-post author and engagement data. ' +
    'The response is often a fraction of the conversation: Bluesky holds replies back past a per-post limit ' +
    'and offers no way to page the rest, so a thread with thousands of replies commonly returns a few hundred. ' +
    'Any node returning fewer replies than its own replyCount carries "truncated: true" with ' +
    '"unreturnedReplies" and a "truncationReason" — "depth" means the reply tree ended there and fetching ' +
    'that node\'s AT-URI as its own thread continues below it, "unavailable" means no request closes the gap. ' +
    'Read "unreturnedReplies" as an upper bound on what is missing rather than a count of readable replies: ' +
    "Bluesky's counter also includes replies that have left the index, so a small difference often means " +
    'nothing is left to fetch. The parent chain is disclosed the same way: when it stops at parent_height ' +
    'instead of at the start of the conversation, the topmost node carries "parentChainTruncated: true" and ' +
    'fetching its AT-URI as its own thread continues upward. The enrichment fields total the difference for ' +
    'the whole thread; check them before describing a conversation as complete or naming its first post. ' +
    "In the rendered text nothing is indented: a reply's author heading carries how far it sits below the " +
    'top-level reply it descends from ("### ↳2"), and every post also names its own parent on a "Reply to" line.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    uri: z
      .string()
      .max(2048)
      .regex(AT_URI_REGEX, AT_URI_MESSAGE)
      .describe(
        'AT-URI of the post to fetch, e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/abc123". ' +
          'All three segments are required — authority (handle or DID), collection, and record key. ' +
          'Obtain from bsky_search_posts or bsky_get_author_feed.',
      ),
    depth: z
      .number()
      .int()
      .min(0)
      .max(MAX_REPLY_DEPTH)
      .default(6)
      .describe(
        `How many levels of replies to include below the target post. Default 6, maximum ${MAX_REPLY_DEPTH} — ` +
          `Bluesky itself returns no more than ${MAX_REPLY_DEPTH} levels however deep the request. ` +
          'Depth does not widen the reply tree either: the per-post reply limit is independent of it. ' +
          "To read below the deepest level returned, fetch an edge node's AT-URI as its own thread.",
      ),
    parent_height: z
      .number()
      .int()
      .min(0)
      .max(MAX_PARENT_HEIGHT)
      .default(80)
      .describe(
        `How many parent posts to include in the parent chain above the target post. Default 80, maximum ${MAX_PARENT_HEIGHT}. ` +
          'The chain is returned level for level up to this many posts and stops early at the conversation root. ' +
          'When it stops at this bound instead, the topmost node carries "parentChainTruncated: true" — fetch ' +
          "that node's AT-URI as its own thread to read above it. Set to 0 to skip the chain entirely; a reply " +
          'target then reports the same marker on itself, since its own parent was not returned either.',
      ),
  }),
  output: z.object({
    thread: ThreadNodeSchema,
    threadgate: ThreadGateSchema.optional(),
  }),

  enrichment: {
    totalReturned: z
      .number()
      .describe(
        'Thread nodes in this response — the target post, its parent chain, and every reply returned.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when at least one post in the reply tree returned fewer replies than Bluesky counts for it.',
      ),
    parentChainTruncated: z
      .boolean()
      .optional()
      .describe(
        'True when the parent chain stopped at parent_height instead of reaching the start of the ' +
          'conversation, so the topmost post returned above the target is not the conversation root. ' +
          'Independent of "truncated", which covers the reply tree, and unlike it fully recoverable: ' +
          "fetch the topmost parent's AT-URI as its own thread to continue upward.",
      ),
    unreturnedReplies: z
      .number()
      .optional()
      .describe(
        'How far the reply counts run ahead of the replies returned, summed across the reply tree. An ' +
          "upper bound on what is missing, not a count of readable replies — Bluesky's counters keep " +
          'including replies that have left the index. Compare against the root post replyCount to judge ' +
          'how much of the conversation is present.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'What this response is missing, how much of the gap is explained, and which part of it can still ' +
          'be reached by a further request.',
      ),
  },

  errors: [
    {
      reason: 'invalid_at_uri',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The AppView rejected the AT-URI — the shape passed the input pattern but the authority, collection, or record key is not one it can resolve.',
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

    let result: PostThreadResult;
    try {
      result = await getBlueskyService().getPostThread(
        { uri: input.uri, depth: input.depth, parentHeight: input.parent_height },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const body = (err.data as { responseBody?: string } | undefined)?.responseBody ?? '';
        if (body.includes('Invalid at-uri')) {
          throw ctx.fail(
            'invalid_at_uri',
            `Bluesky rejected the AT-URI "${input.uri}".`,
            ctx.recoveryFor('invalid_at_uri'),
          );
        }
        if (body.includes('NotFound') || body.includes('not found') || body.includes('Not Found')) {
          throw ctx.fail(
            'post_not_found',
            `Post not found: "${input.uri}"`,
            ctx.recoveryFor('post_not_found'),
          );
        }
      }
      throw err;
    }

    const survey = surveyThread(result.thread, result.threadgate);
    ctx.enrich({ totalReturned: survey.nodes });
    if (survey.unreturnedReplies > 0) {
      ctx.enrich({ truncated: true, unreturnedReplies: survey.unreturnedReplies });
    }
    if (survey.parentChainTopUri) {
      ctx.enrich({ parentChainTruncated: true });
    }
    if (survey.unreturnedReplies > 0 || survey.parentChainTopUri) {
      ctx.enrich.notice(truncationNotice(survey));
    }

    return result;
  },

  format: (result) => {
    const thread = result.thread as ThreadPost;
    /**
     * The gate leads, and leads in every branch: it is the one part of the response that explains
     * a missing reply as a deliberate act rather than an API limit.
     */
    const gate = result.threadgate;
    const gateLines = gate ? renderGateLines(gate) : [];
    /**
     * `post` is checked as well as `notFound`: the node tree is declared `passthrough()`, so an
     * empty node is a valid value of the output schema even though the AppView never sends one.
     */
    if (!thread?.post || thread.notFound) {
      return [{ type: 'text', text: [...gateLines, '*Post not found or deleted.*'].join('\n') }];
    }
    if (thread.blocked) {
      return [
        {
          type: 'text',
          text: [...gateLines, '*Post hidden — its author blocks this view.*'].join('\n'),
        },
      ];
    }
    const lines: string[] = ['# Thread', ...gateLines];
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
    /**
     * The target renders alone — `formatThreadNode` walks `replies` itself, so leaving them
     * on would emit the whole subtree here and again under `## Replies`.
     */
    const { parent: _p, replies: _r2, ...targetOnly } = thread;
    formatThreadNode(targetOnly, 0, lines);
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

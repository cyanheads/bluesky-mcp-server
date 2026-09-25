/**
 * @fileoverview Fetch a Bluesky post conversation thread by AT-URI, disclosing both ways the
 * response falls short of the conversation: how far the AppView's reply counts run ahead of the
 * replies it returned, and whether the parent chain stopped at the requested height rather than at
 * the start of the thread. A thread past the 48,000-byte response budget is cut between whole posts,
 * breadth-first, and the cut is marked on the posts kept so every omitted one is a request away.
 * Reply depth rides the author heading rather than the left margin, so no line of a nested node
 * crosses the four-space threshold that would turn it into a code block.
 * @module mcp-server/tools/definitions/bsky-get-post-thread
 */

import { type ContentBlock, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { renderPostLines } from '@/mcp-server/tools/post-format.js';
import {
  applyEnrichment,
  type EnrichmentValue,
  fitsBudget,
  largestFitting,
  measureResponse,
  RESPONSE_BUDGET_BYTES,
} from '@/mcp-server/tools/response-budget.js';
import {
  AT_URI_REF_MESSAGE,
  AT_URI_REF_REGEX,
  atUriFromRef,
  parseFeedRef,
} from '@/services/bluesky/at-syntax.js';
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

/** @internal How every budget marker names its cause, so a reader can tell it from the AppView's own cuts. */
const BUDGET_CAUSE = `left out to keep this response within its ${RESPONSE_BUDGET_BYTES.toLocaleString('en-US')}-byte budget`;

/** @internal The line above the topmost kept node whose ancestors the budget cut. */
function budgetParentsLine(n: number): string {
  return `*[${n.toLocaleString()} earlier ${n === 1 ? 'post' : 'posts'} in this conversation ${n === 1 ? 'was' : 'were'} ${BUDGET_CAUSE} — fetch this post's AT-URI with bsky_get_post_thread, depth 0 and parent_height ${n} or more, to read above it]*`;
}

/** @internal The line below a kept reply whose own replies the budget cut. */
function budgetRepliesLine(n: number): string {
  const them = n === 1 ? 'it' : 'them';
  return `*[${n.toLocaleString()} more ${n === 1 ? 'reply' : 'replies'} to this post ${n === 1 ? 'was' : 'were'} ${BUDGET_CAUSE}, with everything below ${them} — fetch this post's AT-URI with bsky_get_post_thread, parent_height 0, to read ${them}]*`;
}

/** @internal The line naming the target's direct replies the budget cut, one AT-URI each. */
function budgetReplyUrisLine(uris: readonly string[]): string {
  const n = uris.length;
  return `*[${n.toLocaleString()} more direct ${n === 1 ? 'reply' : 'replies'} to this post ${n === 1 ? 'was' : 'were'} ${BUDGET_CAUSE}, with everything below ${n === 1 ? 'it' : 'them'} — fetch each AT-URI with bsky_get_post_thread, parent_height 0: ${uris.map((uri) => `\`${uri}\``).join(', ')}]*`;
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
  /** Above the node they belong to, since the posts they name sit above it in the conversation. */
  if (node.budgetOmittedParents) {
    lines.push(`${marker}${budgetParentsLine(node.budgetOmittedParents)}`);
  }
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
  if (node.budgetOmittedReplies) {
    lines.push('', `${marker}${budgetRepliesLine(node.budgetOmittedReplies)}`);
  }
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
 * and either alone is enough to make the notice worth sending. A budget cut is a third, told apart
 * from both: the AppView returned those posts, and each is one request away.
 */
function truncationNotice(survey: ThreadSurvey, cut?: ThreadBudgetCut): string {
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
        `For ${postCountLabel(survey.unavailableNodes)}, the difference is not retrievable by any request: Bluesky holds replies back past a per-post limit, and its counts also keep including replies that have left the index, so treat the number as an upper bound on what is missing rather than a count of readable replies.`,
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
  if (cut) parts.push(budgetNotice(cut));
  parts.push('Treat any summary of this conversation as covering only what was returned.');
  return parts.join(' ');
}

/** What the response budget left out of one thread. */
interface ThreadBudgetCut {
  /** Nodes kept, the target included. */
  kept: number;
  /** Nodes the AppView returned that the response left out. */
  omitted: number;
  /** The target's direct replies left out. */
  omittedDirect: number;
  /** Ancestors above the topmost kept parent left out. */
  omittedParents: number;
}

/** @internal The part of the notice a budget cut adds: how much was left out, and the calls that read it. */
function budgetNotice(cut: ThreadBudgetCut): string {
  const deeper = cut.omitted - cut.omittedParents - cut.omittedDirect;
  const left = [
    cut.omittedParents > 0
      ? `${postCountLabel(cut.omittedParents)} higher in the parent chain`
      : '',
    cut.omittedDirect > 0
      ? `${replyCountLabel(cut.omittedDirect)} directly to the requested post`
      : '',
    deeper > 0 ? `${replyCountLabel(deeper)} further down the reply tree` : '',
  ].filter(Boolean);
  const calls = [
    cut.omittedDirect > 0 ? 'each AT-URI in budgetOmittedReplyUris on the requested post' : '',
    deeper > 0 ? 'the AT-URI of every post carrying budgetOmittedReplies' : '',
  ].filter(Boolean);
  return [
    `This response holds ${cut.kept.toLocaleString()} of the ${(cut.kept + cut.omitted).toLocaleString()} posts Bluesky returned: the rest would have run past this server's ${RESPONSE_BUDGET_BYTES.toLocaleString('en-US')}-byte response budget, so ${left.join(', ')} ${cut.omitted === 1 ? 'was' : 'were'} left out whole (budgetOmitted).`,
    calls.length
      ? `Fetch ${calls.join(', and ')} with bsky_get_post_thread, parent_height 0 and the same depth, to read the replies left out.`
      : '',
    cut.omittedParents > 0
      ? 'Fetch the post carrying budgetOmittedParents with depth 0 to read the parent chain above it.'
      : '',
    'A fetch that is itself cut marks its own frontier the same way.',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * @internal The order the budget keeps nodes in: the target, then its parents nearest-first, then its
 * replies level by level in AppView order. Every prefix of it is a connected conversation — a reply
 * is never kept without its parent, and the replies a node keeps are always the first of its own.
 */
function budgetOrder(target: ThreadPost): ThreadPost[] {
  const order: ThreadPost[] = [target];
  for (let p = target.parent; p; p = p.parent) order.push(p);
  for (
    let level = target.replies ?? [];
    level.length;
    level = level.flatMap((n) => n.replies ?? [])
  ) {
    order.push(...level);
  }
  return order;
}

/**
 * @internal The thread cut down to `kept`, with its frontier marked: the target names its cut direct
 * replies by AT-URI, a kept reply counts its cut replies, and the topmost kept parent — or the target,
 * when no parent survives — counts the ancestors cut above it. Nodes are copied; the AppView's own
 * fields on each are left as they were.
 */
function cutThread(target: ThreadPost, kept: ReadonlySet<ThreadPost>) {
  const keepReplies = (node: ThreadPost, isTarget: boolean): ThreadPost => {
    const { parent: _parent, replies = [], ...rest } = node;
    const keptReplies = replies.filter((r) => kept.has(r));
    const omitted = replies.filter((r) => !kept.has(r));
    const marker = isTarget
      ? { budgetOmittedReplyUris: omitted.map((r) => r.post.uri) }
      : { budgetOmittedReplies: omitted.length };
    return {
      ...rest,
      ...(keptReplies.length ? { replies: keptReplies.map((r) => keepReplies(r, false)) } : {}),
      ...(omitted.length ? marker : {}),
    };
  };
  const parents: ThreadPost[] = [];
  for (let p = target.parent; p; p = p.parent) parents.push(p);
  const keptParents = parents.filter((p) => kept.has(p));
  const omittedParents = parents.length - keptParents.length;
  let chain: ThreadPost | undefined;
  for (let i = keptParents.length - 1; i >= 0; i--) {
    const { parent: _parent, ...rest } = keptParents[i] as ThreadPost;
    const topmost = i === keptParents.length - 1;
    chain = {
      ...rest,
      ...(chain ? { parent: chain } : {}),
      ...(topmost && omittedParents ? { budgetOmittedParents: omittedParents } : {}),
    };
  }
  const thread = keepReplies(target, true);
  if (chain) thread.parent = chain;
  else if (omittedParents) thread.budgetOmittedParents = omittedParents;
  const omittedDirect = (target.replies ?? []).filter((r) => !kept.has(r)).length;
  return { thread, omittedDirect, omittedParents };
}

/**
 * @internal The enrichment for one response, in the order the fields are written. The shortfall
 * fields describe what Bluesky did not return, over everything it did return — a budget cut leaves
 * them as the uncut response reports them, so its survey is the uncut one with `nodes` set to the
 * posts kept. The budget pair describes the posts left out.
 */
function threadEnrichment(survey: ThreadSurvey, cut?: ThreadBudgetCut) {
  const enrichment: Record<string, EnrichmentValue> = { totalReturned: survey.nodes };
  if (survey.unreturnedReplies > 0) {
    enrichment.truncated = true;
    enrichment.unreturnedReplies = survey.unreturnedReplies;
  }
  if (survey.parentChainTopUri) enrichment.parentChainTruncated = true;
  if (cut) {
    enrichment.budgetCapped = true;
    enrichment.budgetOmitted = cut.omitted;
  }
  if (survey.unreturnedReplies > 0 || survey.parentChainTopUri || cut) {
    enrichment.notice = truncationNotice(survey, cut);
  }
  return enrichment;
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

/**
 * @internal Plain-language rendering of who a threadgate lets reply. Each rule carries its own
 * `allow` value beside the gloss: the gloss alone reaches a client reading `content[]` with no way
 * back to the machine value `structuredContent` carries, and two of the five glosses do not contain
 * their rule as a word at all.
 */
function gateAudience(gate: ThreadGateView): string {
  if (!gate.allow) return 'Replies are open to anyone';
  if (gate.allow.length === 0) return 'Replies are turned off';
  const rules = gate.allow.map((r) => `${GATE_AUDIENCE[r]} (\`${r}\`)`).join(', ');
  return `Replies are limited to ${rules}`;
}

/**
 * Thread node schema — uses passthrough so all post fields (uri, cid, text, author, engagement counts,
 * createdAt, labels, embed, replyToUri, replyRootUri) and thread structure (parent, replies, truncated,
 * truncationReason, unreturnedReplies, notFound, blocked) flow through structuredContent without
 * format-parity constraints on the recursive tree shape.
 *
 * Passthrough is why the node this describes must be normalized down to what it names: the sibling
 * tools declare their post shape as a closed object, so an extra field is stripped there and
 * survives here. The author fields listed below are the ones the service carries and the renderer
 * emits — widening the normalized author again would put fields in this channel alone.
 */
const ThreadNodeSchema: z.ZodType<unknown> = z
  .object({})
  .passthrough()
  .describe(
    'The conversation thread rooted at the requested post — a recursive node tree. Each node has: ' +
      'post: { uri, cid, text, author: { did, handle, displayName?, avatar?, verification? }, replyCount?, repostCount?, likeCount?, quoteCount?, indexedAt?, createdAt?, labels?: [{ val, src?, cts? }], embed?, replyToUri?, replyRootUri? }. ' +
      'author.verification: { verifiedStatus, trustedVerifierStatus } — whether a trusted verifier verified the author and whether the author is one, each "valid", "invalid" (verified once, no longer holds), or "none", passed through as Bluesky sends it; absent when Bluesky sent none. ' +
      'quoteCount counts quote posts, which are not part of the thread — read them with bsky_get_post_quotes. ' +
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
      'carries the author DID on post.author.did. ' +
      "Set only when this server's 48,000-byte response budget cut the thread (budgetCapped), on the posts " +
      'Bluesky did return: budgetOmittedReplyUris?: on the target, the AT-URIs of its direct replies left ' +
      'out, in Bluesky order — fetch each as its own thread (parent_height 0) to read it and everything ' +
      'below it. budgetOmittedReplies?: on any other node, how many of its direct replies were left out, ' +
      "each with everything below it — fetch the node's post.uri as its own thread (parent_height 0). " +
      'budgetOmittedParents?: on the topmost parent kept, or the target when none was, how many ancestors ' +
      "above it were left out — fetch the node's post.uri with depth 0 to read them. Independent of " +
      'truncated / unreturnedReplies / parentChainTruncated, which describe what Bluesky itself did not return.',
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

const ThreadOutput = z.object({
  thread: ThreadNodeSchema,
  threadgate: ThreadGateSchema.optional(),
});

/** Module-level so the handler can measure the rendered thread against the response budget. */
function formatThread(result: z.infer<typeof ThreadOutput>): ContentBlock[] {
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
  const cutUris = thread.budgetOmittedReplyUris ?? [];
  if (thread.replies?.length || cutUris.length) {
    lines.push('');
    lines.push('## Replies');
    for (const reply of thread.replies ?? []) {
      formatThreadNode(reply, 0, lines);
      lines.push('');
    }
    /** After the replies kept, since the ones it names follow them in Bluesky's order. */
    if (cutUris.length) lines.push(budgetReplyUrisLine(cutUris), '');
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

export const bskyGetPostThread = tool('bsky_get_post_thread', {
  title: 'Get Bluesky Post Thread',
  description:
    'Fetch the conversation for a post by AT-URI — the parent chain upward and the reply tree downward. ' +
    'Enter the thread at any point and traverse the discussion. ' +
    'AT-URIs have the format "at://<handle-or-did>/<collection>/<rkey>" and are returned in the "uri" field ' +
    'of every post the other post-returning tools emit, such as bsky_get_feed and bsky_get_author_feed; ' +
    'a bsky.app post URL (https://bsky.app/profile/<handle-or-did>/post/<rkey>) works as-is. ' +
    'Returns the root post, parent chain, and nested replies with per-post author and engagement data. ' +
    'Replies only: quote posts are not part of a thread — read them with bsky_get_post_quotes. ' +
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
    "A thread that would pass this server's 48,000-byte response budget is cut between whole posts — the " +
    'target kept first, then its parents nearest-first, then replies level by level — with "budgetCapped: ' +
    'true" and the cut marked where it happened: "budgetOmittedReplyUris" on the target and ' +
    '"budgetOmittedReplies" on a kept reply name the replies left out, "budgetOmittedParents" on the ' +
    'topmost parent the ancestors; fetching those AT-URIs as their own threads reads the rest. ' +
    "In the rendered text nothing is indented: a reply's author heading carries how far it sits below the " +
    'top-level reply it descends from ("### ↳2"), and every post also names its own parent on a "Reply to" line.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    uri: z
      .string()
      .max(2048)
      .regex(AT_URI_REF_REGEX, AT_URI_REF_MESSAGE)
      .describe(
        'AT-URI of the post to fetch, e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/abc123". ' +
          'All three segments are required — authority (handle or DID), collection, and record key. ' +
          'Obtain from the "uri" field of a post returned by bsky_get_feed or bsky_get_author_feed. ' +
          'The post\'s bsky.app page, e.g. "https://bsky.app/profile/bsky.app/post/abc123", is accepted and ' +
          'read as the AT-URI it names; a trailing "/", "?…", or "#…" on it is ignored.',
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
  output: ThreadOutput,

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
        'True when at least one post in the reply tree returned fewer replies than Bluesky counts for it — ' +
          'counted over every post Bluesky returned, including any the response budget left out.',
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
          'including replies that have left the index. Summed over every post Bluesky returned, including ' +
          'any the response budget left out. Compare against the root post replyCount to judge how much of ' +
          'the conversation is present.',
      ),
    budgetCapped: z
      .boolean()
      .optional()
      .describe(
        "True when the whole thread would have passed this server's 48,000-byte response budget, so " +
          'posts Bluesky returned were left out whole — the target first kept, then its parents ' +
          'nearest-first, then replies level by level. The nodes at the cut carry budgetOmittedReplyUris, ' +
          'budgetOmittedReplies, or budgetOmittedParents, and fetching those AT-URIs reads everything left ' +
          'out. Independent of "truncated" and "parentChainTruncated", which describe what Bluesky did not return.',
      ),
    budgetOmitted: z
      .number()
      .optional()
      .describe(
        'How many posts Bluesky returned that the response budget left out, set alongside budgetCapped. ' +
          'totalReturned counts the posts kept.',
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
        'Copy the AT-URI unchanged from the "uri" field of a post returned by bsky_get_feed or bsky_get_author_feed.',
    },
    {
      reason: 'post_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The AT-URI is well-formed but the post was deleted or never existed.',
      recovery:
        "Verify the AT-URI, or re-read the author's recent posts with bsky_get_author_feed to find the post's current AT-URI.",
    },
    {
      reason: 'uri_is_feed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The AT-URI names a feed generator (app.bsky.feed.generator), not a post.',
      recovery: "Read the feed's posts with bsky_get_feed, passing this AT-URI as its feed.",
    },
  ],

  async handler(input, ctx) {
    /** A bsky.app post URL becomes its AT-URI; the handle it carries is kept, since the AppView resolves one. */
    const uri = atUriFromRef(input.uri);
    ctx.log.info('Fetching Bluesky post thread', { uri, depth: input.depth });

    /**
     * A feed AT-URI passes the AT-URI pattern, and the AppView answers it as a missing post, which
     * would send the caller looking for a post that was never there.
     */
    if (parseFeedRef(uri)) {
      throw ctx.fail(
        'uri_is_feed',
        `"${uri}" is a feed generator, not a post — read its posts with bsky_get_feed.`,
        ctx.recoveryFor('uri_is_feed'),
      );
    }

    let result: PostThreadResult;
    try {
      result = await getBlueskyService().getPostThread(
        { uri, depth: input.depth, parentHeight: input.parent_height },
        ctx,
      );
    } catch (err) {
      if (err instanceof McpError) {
        const body = (err.data as { responseBody?: string } | undefined)?.responseBody ?? '';
        if (body.includes('Invalid at-uri')) {
          throw ctx.fail(
            'invalid_at_uri',
            `Bluesky rejected the AT-URI "${uri}".`,
            ctx.recoveryFor('invalid_at_uri'),
          );
        }
        if (body.includes('NotFound') || body.includes('not found') || body.includes('Not Found')) {
          throw ctx.fail(
            'post_not_found',
            `Post not found: "${uri}"`,
            ctx.recoveryFor('post_not_found'),
          );
        }
      }
      throw err;
    }

    const gate = result.threadgate;
    const measure = (response: PostThreadResult, enrichment: Record<string, EnrichmentValue>) =>
      measureResponse(ThreadOutput.parse(response), formatThread, enrichment);
    const survey = surveyThread(result.thread, gate);
    const whole = threadEnrichment(survey);
    const order = budgetOrder(result.thread);
    if (order.length === 1 || fitsBudget(measure(result, whole))) {
      applyEnrichment(ctx, whole);
      return result;
    }

    /**
     * Over the budget: keep the longest prefix of the budget order whose response fits. A kept node
     * costs far more than the marker it retires, so a response grows with every node kept and the
     * search is sound; the prefix of one — the target alone — is kept whatever its size.
     */
    const build = (kept: number) => {
      const cut = cutThread(result.thread, new Set(order.slice(0, kept)));
      const response: PostThreadResult = {
        thread: cut.thread,
        ...(gate ? { threadgate: gate } : {}),
      };
      const enrichment = threadEnrichment(
        { ...survey, nodes: kept },
        {
          kept,
          omitted: order.length - kept,
          omittedDirect: cut.omittedDirect,
          omittedParents: cut.omittedParents,
        },
      );
      return { response, enrichment };
    };
    const kept = largestFitting(order.length - 1, (n) => {
      const { response, enrichment } = build(n);
      return fitsBudget(measure(response, enrichment));
    });
    const { response, enrichment } = build(kept);
    ctx.log.info('Thread cut to the response budget', { kept, omitted: order.length - kept });
    applyEnrichment(ctx, enrichment);
    return response;
  },

  format: formatThread,
});

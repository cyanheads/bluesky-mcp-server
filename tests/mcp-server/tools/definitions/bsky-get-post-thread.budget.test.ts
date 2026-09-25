/**
 * @fileoverview bsky_get_post_thread under the 48,000-byte response budget, through the real
 * service over a faked `getPostThread` that answers for any node of a synthetic conversation. The
 * cut keeps the target, then parents nearest-first, then replies level by level in AppView order,
 * and marks its frontier: `budgetOmittedReplies` on a kept reply whose own replies were cut,
 * `budgetOmittedReplyUris` on the target, `budgetOmittedParents` on the topmost parent kept. The
 * walk test follows every marker with further calls and requires every node of the conversation to
 * be reached.
 * @module tests/mcp-server/tools/definitions/bsky-get-post-thread.budget.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import {
  buildTree,
  postUri,
  routeThread,
  surfaces,
  type TreeNode,
  textOf,
} from '../budget-fixtures.js';

const BUDGET = 48_000;

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});

afterEach(() => {
  http.restore();
});

interface Node {
  budgetOmittedParents?: number;
  budgetOmittedReplies?: number;
  budgetOmittedReplyUris?: string[];
  parent?: Node;
  parentChainTruncated?: boolean;
  post: { uri: string };
  replies?: Node[];
  truncated?: boolean;
  truncationReason?: string;
}
interface Thread {
  budgetCapped?: boolean;
  budgetOmitted?: number;
  notice?: string;
  parentChainTruncated?: boolean;
  thread: Node;
  totalReturned: number;
  truncated?: boolean;
}

const sc = (result: { structuredContent?: unknown }) => result.structuredContent as Thread;
const rkeyOf = (node: Node) => node.post.uri.split('/').at(-1) ?? '';

/** Every reply node, with its level below the target. */
function replies(node: Node, level = 1): Array<{ node: Node; level: number }> {
  return (node.replies ?? []).flatMap((r) => [{ node: r, level }, ...replies(r, level + 1)]);
}

function parents(node: Node): Node[] {
  return node.parent ? [node.parent, ...parents(node.parent)] : [];
}

/** Rkeys of every node at `level` below `root` in the synthetic tree, in AppView order. */
function levelOf(tree: Map<string, TreeNode>, level: number, root = 'root'): string[] {
  let keys = [root];
  for (let i = 0; i < level; i++) keys = keys.flatMap((k) => tree.get(k)?.children ?? []);
  return keys;
}

async function thread(uri: string, extra: Record<string, number> = {}) {
  const result = await runToolContract(bskyGetPostThread, { uri, ...extra });
  expect(result.isError).toBeFalsy();
  return result;
}

describe('the breadth-first cut', () => {
  it('cut at level 3: keeps levels 1–2 whole, a prefix of level 3, and marks each level-2 node it cut below', async () => {
    const tree = buildTree({ branching: [4, 3, 3], descriptionBytes: 600 });
    routeThread(http, tree);
    const result = await thread(postUri('root'));
    const out = sc(result);

    const kept = replies(out.thread);
    const byLevel = (l: number) => kept.filter((r) => r.level === l).map((r) => rkeyOf(r.node));
    expect(byLevel(1)).toEqual(levelOf(tree, 1));
    expect(byLevel(2)).toEqual(levelOf(tree, 2));
    const level3 = byLevel(3);
    expect(level3.length).toBeGreaterThan(0);
    expect(level3.length).toBeLessThan(36);
    expect(level3).toEqual(levelOf(tree, 3).slice(0, level3.length));

    for (const { node, level } of kept) {
      const all = tree.get(rkeyOf(node))?.children ?? [];
      const keptChildren = (node.replies ?? []).length;
      if (level === 2 && keptChildren < all.length) {
        expect(node.budgetOmittedReplies).toBe(all.length - keptChildren);
      } else {
        expect(node).not.toHaveProperty('budgetOmittedReplies');
      }
    }
    expect(out.thread).not.toHaveProperty('budgetOmittedReplyUris');
    expect(out).toMatchObject({
      budgetCapped: true,
      budgetOmitted: tree.size - 1 - kept.length,
      totalReturned: 1 + kept.length,
    });
    expect(out).not.toHaveProperty('truncated');
    const size = surfaces(result);
    expect(size.structured).toBeLessThanOrEqual(BUDGET);
    expect(size.content).toBeLessThanOrEqual(BUDGET);
    expect(Math.max(size.structured, size.content)).toBeGreaterThan(BUDGET - 2000);
  });

  it('cut at level 2: marks the level-1 nodes it cut below, and nothing deeper survives', async () => {
    const tree = buildTree({ branching: [4, 3, 3], descriptionBytes: 3000 });
    routeThread(http, tree);
    const out = sc(await thread(postUri('root')));

    const kept = replies(out.thread);
    expect(kept.filter((r) => r.level === 1)).toHaveLength(4);
    const level2 = kept.filter((r) => r.level === 2).map((r) => rkeyOf(r.node));
    expect(level2.length).toBeGreaterThan(0);
    expect(level2.length).toBeLessThan(12);
    expect(level2).toEqual(levelOf(tree, 2).slice(0, level2.length));
    expect(kept.some((r) => r.level === 3)).toBe(false);

    for (const { node, level } of kept) {
      const all = tree.get(rkeyOf(node))?.children.length ?? 0;
      const omitted = all - (node.replies ?? []).length;
      expect(node.budgetOmittedReplies ?? 0).toBe(omitted);
      if (level === 1) expect(omitted).toBeGreaterThanOrEqual(0);
    }
    /** The frontier spans two levels: level-1 nodes lose part of level 2, kept level-2 nodes all of level 3. */
    const markedAt = (l: number) =>
      kept.filter((r) => r.level === l && r.node.budgetOmittedReplies);
    expect(markedAt(1)).not.toHaveLength(0);
    expect(markedAt(2)).toHaveLength(level2.length);
    for (const { node } of markedAt(2)) expect(node.budgetOmittedReplies).toBe(3);
  });

  it("lists the target's cut direct replies by AT-URI, in AppView order, on both surfaces", async () => {
    const tree = buildTree({ branching: [80], descriptionBytes: 600 });
    routeThread(http, tree);
    const result = await thread(postUri('root'));
    const out = sc(result);

    const keptDirect = (out.thread.replies ?? []).map(rkeyOf);
    const all = levelOf(tree, 1);
    expect(keptDirect).toEqual(all.slice(0, keptDirect.length));
    const omitted = all.slice(keptDirect.length).map((k) => postUri(k));
    expect(out.thread.budgetOmittedReplyUris).toEqual(omitted);
    expect(out.budgetOmitted).toBe(omitted.length);
    const text = textOf(result);
    for (const uri of omitted) expect(text).toContain(`\`${uri}\``);
    expect(surfaces(result).structured).toBeLessThanOrEqual(BUDGET);
  });

  it('cuts a long parent chain nearest-first and marks the topmost parent it kept', async () => {
    const tree = buildTree({ branching: [5], chain: 70, descriptionBytes: 600 });
    routeThread(http, tree);
    const result = await thread(postUri('root'), { parent_height: 100 });
    const out = sc(result);

    const chain = parents(out.thread).map(rkeyOf);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.length).toBeLessThan(70);
    /** Nearest first: a001 is the root's own parent. */
    expect(chain).toEqual(
      Array.from({ length: chain.length }, (_, i) => `a${String(i + 1).padStart(3, '0')}`),
    );
    const top = parents(out.thread).at(-1);
    expect(top?.budgetOmittedParents).toBe(70 - chain.length);
    expect(
      parents(out.thread)
        .slice(0, -1)
        .every((p) => !('budgetOmittedParents' in p)),
    ).toBe(true);
    /** Replies rank after every parent, so the target's replies are all listed as cut. */
    expect(out.thread.budgetOmittedReplyUris).toEqual(levelOf(tree, 1).map((k) => postUri(k)));
    expect(out).not.toHaveProperty('parentChainTruncated');
    const text = textOf(result);
    expect(text).toContain(`${70 - chain.length} earlier posts`);
  });

  it('marks the target when the budget left no parent at all', async () => {
    const tree = buildTree({
      branching: [2],
      chain: 3,
      descriptionBytes: (rkey) => (rkey === 'root' ? 47_000 : 600),
    });
    routeThread(http, tree);
    const out = sc(await thread(postUri('root')));

    expect(out.thread).not.toHaveProperty('parent');
    expect(out.thread.budgetOmittedParents).toBe(3);
    expect(out.thread.budgetOmittedReplyUris).toHaveLength(2);
    expect(out.thread).not.toHaveProperty('parentChainTruncated');
  });

  it('keeps a target larger than the budget, alone, with every reply listed', async () => {
    const tree = buildTree({
      branching: [3, 2],
      descriptionBytes: (rkey) => (rkey === 'root' ? 60_000 : 600),
    });
    routeThread(http, tree);
    const result = await thread(postUri('root'));
    const out = sc(result);

    expect(out.thread).not.toHaveProperty('replies');
    expect(out.thread.budgetOmittedReplyUris).toEqual(levelOf(tree, 1).map((k) => postUri(k)));
    expect(out).toMatchObject({ totalReturned: 1, budgetOmitted: 9, budgetCapped: true });
    expect(surfaces(result).structured).toBeGreaterThan(BUDGET);
  });

  it('keeps the AppView shortfall fields apart from the budget ones, and composes one notice', async () => {
    /** depth 2 on a three-level tree: level-2 nodes end the tree with replies below them. */
    const tree = buildTree({ branching: [4, 3, 3], descriptionBytes: 2500 });
    routeThread(http, tree);
    const result = await thread(postUri('root'), { depth: 2 });
    const out = sc(result);

    const level2 = replies(out.thread).filter((r) => r.level === 2);
    expect(level2.length).toBeGreaterThan(0);
    for (const { node } of level2) {
      expect(node).toMatchObject({ truncated: true, truncationReason: 'depth' });
      expect(node).not.toHaveProperty('budgetOmittedReplies');
    }
    expect(out).toMatchObject({ truncated: true, budgetCapped: true });
    expect(out.notice).toContain('This thread is partial');
    expect(out.notice).toContain('48,000');
    expect(out.notice).toMatch(
      /Treat any summary of this conversation as covering only what was returned\.$/,
    );
    expect(textOf(result)).toContain(`> ${out.notice}`);
  });

  it('totals the AppView shortfall over every post Bluesky returned, not only the ones kept', async () => {
    /** depth 2: all twelve level-2 nodes end the tree with three replies each below them. */
    const tree = buildTree({ branching: [4, 3, 3], descriptionBytes: 4000 });
    routeThread(http, tree);
    const result = await thread(postUri('root'), { depth: 2 });
    const out = sc(result);

    const keptLevel2 = replies(out.thread).filter((r) => r.level === 2);
    expect(keptLevel2.length).toBeLessThan(12);
    expect(out).toMatchObject({ budgetCapped: true, truncated: true, unreturnedReplies: 36 });
    expect(out.notice).toContain('run 36 replies ahead of what it returned');
    expect(out.notice).toContain('12 posts sit at the edge of the reply tree');
    expect(textOf(result)).toContain('**unreturnedReplies:** 36');
    expect(textOf(result)).toContain(`> ${out.notice}`);
  });

  it('still reports a parent chain Bluesky cut at parent_height when the budget left its top out', async () => {
    const tree = buildTree({ branching: [2], chain: 90, descriptionBytes: 1500 });
    routeThread(http, tree);
    const result = await thread(postUri('root'), { parent_height: 60 });
    const out = sc(result);

    const kept = parents(out.thread);
    expect(kept.length).toBeLessThan(60);
    expect(kept.every((p) => !p.parentChainTruncated)).toBe(true);
    expect(out).toMatchObject({ budgetCapped: true, parentChainTruncated: true });
    expect(out.notice).toContain(postUri('a060'));
    expect(out.notice).toContain('not the start of the thread');
    expect(textOf(result)).toContain('**parentChainTruncated:** true');
  });

  it('renders each marker as its own line, outside every quote', async () => {
    const tree = buildTree({ branching: [4, 3, 3], descriptionBytes: 600 });
    routeThread(http, tree);
    const text = textOf(await thread(postUri('root')));

    const marker = text
      .split('\n')
      .filter((l) => l.includes('left out to keep this response within its 48,000-byte budget'));
    expect(marker.length).toBeGreaterThan(0);
    for (const line of marker) {
      expect(line).toMatch(/^(?:↳\d )?\*\[/);
      const i = text.split('\n').indexOf(line);
      expect(text.split('\n')[i - 1]).toBe('');
    }
  });
});

describe('following the frontier', () => {
  it('reaches every node of the conversation, re-rooting at each marker the cut names', async () => {
    const tree = buildTree({ branching: [6, 4, 3], chain: 30, descriptionBytes: 600 });
    routeThread(http, tree);

    const seen = new Set<string>();
    const queue: Array<{ uri: string; depth: number; parent_height: number }> = [
      { uri: postUri('root'), depth: 6, parent_height: 100 },
    ];
    const asked = new Set<string>();
    let calls = 0;
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      const key = JSON.stringify(next);
      if (asked.has(key)) continue;
      asked.add(key);
      calls++;
      const result = await thread(next.uri, {
        depth: next.depth,
        parent_height: next.parent_height,
      });
      const size = surfaces(result);
      expect(size.structured).toBeLessThanOrEqual(BUDGET);
      expect(size.content).toBeLessThanOrEqual(BUDGET);
      const root = sc(result).thread;
      for (const node of [root, ...parents(root), ...replies(root).map((r) => r.node)]) {
        seen.add(rkeyOf(node));
        if (node.budgetOmittedParents) {
          queue.push({ uri: node.post.uri, depth: 0, parent_height: 100 });
        }
        if (node.budgetOmittedReplies) {
          queue.push({ uri: node.post.uri, depth: 6, parent_height: 0 });
        }
        for (const uri of node.budgetOmittedReplyUris ?? []) {
          queue.push({ uri, depth: 6, parent_height: 0 });
        }
      }
    }

    expect([...tree.keys()].filter((k) => !seen.has(k))).toEqual([]);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(tree.size);
  });
});

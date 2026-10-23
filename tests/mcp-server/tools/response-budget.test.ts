/**
 * @fileoverview The response-budget module on its own terms. The framework renders the enrichment
 * trailer in a function no public entry point exports, so the budget measures a copy of it; these
 * tests hold the copy to the framework's own bytes by running a probe tool through
 * `runToolContract` for every field shape the post tools set, and hold `measureResponse` to the
 * bytes a client receives on both surfaces. Also covers the binary search and the re-request loop's
 * bound in isolation.
 * @module tests/mcp-server/tools/response-budget.test
 */

import { type ContentBlock, tool, z } from '@cyanheads/mcp-ts-core';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import * as utilities from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  applyEnrichment,
  type EnrichmentValues,
  enrichmentTrailer,
  fitPage,
  largestFitting,
  MAX_BUDGET_REFETCHES,
  measureResponse,
  pageEnrichment,
  RESPONSE_BUDGET_BYTES,
} from '@/mcp-server/tools/response-budget.js';
import { surfaces } from './budget-fixtures.js';

vi.mock('@cyanheads/mcp-ts-core/utils', { spy: true });

const ProbeOutput = z.object({
  items: z.array(z.string().describe('An item.')).describe('Items.'),
  cursor: z.string().optional().describe('Cursor.'),
});

const formatProbe = (result: z.infer<typeof ProbeOutput>): ContentBlock[] => [
  { type: 'text', text: `${result.items.map((i) => `> ${i}`).join('\n')}\n\n— émoji ✓ 🧵` },
];

/** A tool whose handler writes a given enrichment record the way the post tools do. */
const probe = (values: EnrichmentValues) =>
  tool('budget_probe', {
    description: 'Probe the enrichment trailer.',
    input: z.object({}),
    output: ProbeOutput,
    enrichment: {
      totalReturned: z.number().optional().describe('n'),
      truncated: z.boolean().optional().describe('t'),
      shown: z.number().optional().describe('s'),
      cap: z.number().optional().describe('c'),
      budgetCapped: z.boolean().optional().describe('b'),
      budgetOmitted: z.number().optional().describe('o'),
      notice: z.string().optional().describe('n'),
    },
    handler(_input, ctx) {
      applyEnrichment(ctx, values);
      return { items: ['one', 'twö'], cursor: 'c1' };
    },
    format: formatProbe,
  });

const SHAPES: Array<[string, EnrichmentValues]> = [
  ['a count alone', { totalReturned: 3 }],
  ['a notice alone', { notice: 'Nothing matched — try again.' }],
  [
    'the paged-tool shape with a notice last',
    {
      totalReturned: 37,
      truncated: true,
      shown: 37,
      cap: 100,
      budgetCapped: true,
      notice: 'More posts exist. This page holds 37 of the 100 posts asked for.',
    },
  ],
  [
    'a notice followed by further fields',
    {
      notice: 'Notice first.',
      totalReturned: 1,
      budgetCapped: false,
    },
  ],
  [
    'the thread shape',
    { totalReturned: 59, budgetCapped: true, budgetOmitted: 460, notice: 'Cut — ünïcode.' },
  ],
];

describe('enrichmentTrailer — the framework trailer, byte for byte', () => {
  it.each(SHAPES)('matches the framework for %s', async (_label, values) => {
    const result = await runToolContract(probe(values), {});
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: 'text', text: enrichmentTrailer(values) });
  });

  it('adds no block for no enrichment', async () => {
    const result = await runToolContract(probe({}), {});
    expect(result.content).toHaveLength(1);
    expect(enrichmentTrailer({})).toBe('');
  });
});

describe('measureResponse — the bytes a client receives', () => {
  it.each(SHAPES)('matches both surfaces of the real response for %s', async (_label, values) => {
    const result = await runToolContract(probe(values), {});
    const parsed = ProbeOutput.parse({ items: ['one', 'twö'], cursor: 'c1' });
    expect(measureResponse(parsed, formatProbe, values)).toEqual(surfaces(result));
  });
});

describe('read-limit disclosure', () => {
  it('counts and logs only clamped fields, with bounded metric attributes', async () => {
    vi.resetModules();
    const add = vi.fn();
    const counter = vi.mocked(utilities.createCounter).mockReturnValueOnce({ add });
    try {
      const { clampReadLimit } = await import('@/mcp-server/tools/read-limits.js');
      const ctx = createMockContext();
      const log = vi.spyOn(ctx.log, 'info');
      expect(clampReadLimit(ctx, 'bsky_get_feed', 'limit', 100, 100)).toEqual({ applied: 100 });
      expect(add).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(clampReadLimit(ctx, 'bsky_get_feed', 'limit', 150, 100)).toEqual({
        applied: 100,
        notice: 'limit 150 requested; 100 applied.',
      });
      expect(counter).toHaveBeenCalledOnce();
      expect(add).toHaveBeenCalledExactlyOnceWith(1, { tool: 'bsky_get_feed', field: 'limit' });
      expect(log).toHaveBeenCalledExactlyOnceWith('Clamped Bluesky read limit', {
        tool: 'bsky_get_feed',
        field: 'limit',
        requested: 150,
        applied: 100,
      });
    } finally {
      counter.mockRestore();
    }
  });

  it.each([
    { shown: 0, cursor: undefined, requested: undefined, guidance: 'No more posts.' },
    { shown: 0, cursor: undefined, requested: 4, guidance: 'No more posts.' },
    { shown: 0, cursor: 'next', requested: undefined, guidance: 'Continue with cursor.' },
    { shown: 4, cursor: 'next', requested: 4, guidance: 'Continue with cursor.' },
  ])(
    'measures the single composed notice for $shown posts and cursor $cursor',
    async ({ shown, cursor, requested, guidance }) => {
      const values = pageEnrichment({
        clampNotice: 'limit 150 requested; 100 applied.',
        cursor,
        empty: 'No more posts.',
        limit: 100,
        more: 'Continue with cursor.',
        noun: 'posts',
        requested,
        shown,
      });
      expect(values.notice).toContain('limit 150 requested; 100 applied.');
      expect(values.notice).toContain(guidance);
      if (requested !== undefined) expect(values.notice).toContain('48,000-byte response budget');
      const result = await runToolContract(probe(values), {});
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject(values);
      expect(result.content[1]).toEqual({ type: 'text', text: enrichmentTrailer(values) });
      expect(
        measureResponse(
          ProbeOutput.parse({ items: ['one', 'twö'], cursor: 'c1' }),
          formatProbe,
          values,
        ),
      ).toEqual(surfaces(result));
    },
  );
});

describe('largestFitting', () => {
  it('finds the largest n that fits, at every boundary', () => {
    for (let count = 1; count <= 40; count++) {
      for (let limit = 0; limit <= count + 1; limit++) {
        const found = largestFitting(count, (n) => n <= limit);
        expect(found).toBe(Math.max(1, Math.min(limit, count)));
      }
    }
  });

  it('keeps the first record when nothing fits', () => {
    expect(largestFitting(100, () => false)).toBe(1);
  });
});

describe('fitPage — the re-request loop', () => {
  /** A page of `n` records, each `bytes` large, measured as the records alone. */
  const page = (n: number, bytes: number) => ({ n, bytes });
  type P = ReturnType<typeof page>;
  const fitOf = (answer: (limit: number, call: number) => P) => {
    const sent: number[] = [];
    return {
      sent,
      fit: {
        count: (p: P) => p.n,
        limit: 100,
        limitFor: (_p: P, kept: number) => kept,
        measure: (p: P, kept: number) => ({ structured: kept * p.bytes, content: kept * p.bytes }),
        refetch: async (limit: number) => {
          sent.push(limit);
          return answer(limit, sent.length);
        },
      },
    };
  };

  it('returns a page that fits without asking again', async () => {
    const { fit, sent } = fitOf(() => page(0, 0));
    const result = await fitPage(page(40, 1000), fit);
    expect(result).toEqual({ page: page(40, 1000) });
    expect(sent).toEqual([]);
  });

  it('asks once for the largest prefix that fits, and returns that answer', async () => {
    const { fit, sent } = fitOf((limit) => page(limit, 1000));
    const result = await fitPage(page(100, 1000), fit);
    expect(sent).toEqual([Math.floor(RESPONSE_BUDGET_BYTES / 1000)]);
    expect(result).toEqual({ page: page(48, 1000), requested: 48 });
  });

  it('never asks for more than one fewer than the last request, however small the records', async () => {
    const { fit, sent } = fitOf((limit, call) => page(limit, call === 1 ? 10_000 : 1));
    await fitPage(page(100, 1000), fit);
    expect(sent[0]).toBe(48);
    expect(sent[1]).toBe(4);
    expect(sent).toHaveLength(2);
  });

  it(`stops after ${MAX_BUDGET_REFETCHES} re-requests, the last at limit 1`, async () => {
    /** Each answer three times heavier than the one it was predicted from. */
    const { fit, sent } = fitOf((limit, call) => page(limit, 1000 * 3 ** call));
    const result = await fitPage(page(100, 1000), fit);
    expect(sent).toEqual([48, 16, 1]);
    expect(sent).toHaveLength(MAX_BUDGET_REFETCHES);
    expect(result.requested).toBe(1);
  });

  it('stops early once the prediction reaches one record', async () => {
    const { fit, sent } = fitOf((limit) => page(limit, RESPONSE_BUDGET_BYTES));
    const result = await fitPage(page(100, 1000), fit);
    expect(sent).toEqual([48, 1]);
    expect(result.requested).toBe(1);
  });

  it('never re-requests a caller who asked for one record', async () => {
    const { fit, sent } = fitOf(() => page(1, 1));
    const result = await fitPage(page(1, 99_999), { ...fit, limit: 1 });
    expect(sent).toEqual([]);
    expect(result).toEqual({ page: page(1, 99_999) });
  });
});

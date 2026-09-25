/**
 * @fileoverview The per-surface response budget for the five post-bearing tools. `limit`, `depth`,
 * and `parent_height` bound how many records a response carries, never how many bytes: a post
 * renders to about a kilobyte on each surface, one link-card description or alt text can run to
 * tens of kilobytes, and a thread's width is set by its replies. So each tool measures the response
 * it is about to return — `structuredContent` as serialized, `content[]` as rendered, with the
 * framework's enrichment trailer — and cuts between whole records when either surface would pass
 * {@link RESPONSE_BUDGET_BYTES}. The first record always survives. A response that fits is returned
 * exactly as it would be without the budget.
 *
 * The paged tools cut by asking Bluesky again for fewer posts ({@link respondWithinBudget}, over
 * {@link fitPage}), so a page's posts and its cursor always come from one upstream answer; the
 * thread tool cuts locally and marks what it left out. Both measure through {@link measureResponse}.
 * @module mcp-server/tools/response-budget
 */

import type { ContentBlock, Context } from '@cyanheads/mcp-ts-core';

/**
 * Bytes either surface may carry, UTF-8, not configurable. Sized on measured responses: every
 * default-`limit` page measured came in at 30.2 KB per surface or less, and 48 KB of identifier-dense
 * JSON stays under the 25,000-token ceiling at which Claude Code swaps a tool result for a file
 * reference even at 2 characters per token. Each surface is held to it separately — a client
 * forwards one of the two to the model.
 */
export const RESPONSE_BUDGET_BYTES = 48_000;

/**
 * Re-requests a paged tool may make for one call after its first page overflowed. The first two ask
 * for the number of posts the last page predicts will fit; the third asks for one post, whose
 * response is returned whatever its size. A chronological endpoint answers the first re-request with
 * a prefix of the page it already sent, so one is the ordinary case; a ranked feed reranks on every
 * call and may need more.
 */
export const MAX_BUDGET_REFETCHES = 3;

/** An enrichment value a budgeted tool sets — every one is a scalar. */
export type EnrichmentValue = boolean | number | string;

/**
 * Enrichment as an ordered record: the order of its keys is the order the fields are written to
 * `ctx.enrich`, which is the order the framework renders them in the `content[]` trailer. `notice`
 * is written through `ctx.enrich.notice()`, every other key through the bare call.
 */
export type EnrichmentValues = Readonly<Record<string, EnrichmentValue>>;

/** UTF-8 byte size of each surface of one response. */
export interface SurfaceBytes {
  content: number;
  structured: number;
}

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

/**
 * @internal True when a line opens a CommonMark container that would take in the next line — a
 * block quote or a list item. The framework's trailer renderer puts a blank line after such a field.
 */
const OPENS_LAZY_CONTAINER = /^ {0,3}(?:>|(?:[-+*]|\d{1,9}[.)])(?: |$))/;

/**
 * The `content[]` block the framework appends for `values`, byte for byte: a leading blank line,
 * then one line per field — `> text` for the notice, `**key:** value` for the rest — with a blank
 * line after any line that opens a quote or a list. The framework renders it
 * in a function no public entry point exports, so the budget carries this copy, and a test holds the
 * two to the same bytes for every field shape the tools set.
 */
export function enrichmentTrailer(values: EnrichmentValues): string {
  let text = '';
  for (const [key, value] of Object.entries(values)) {
    const field = key === 'notice' ? `> ${value}` : `**${key}:** ${value}`;
    if (text)
      text += OPENS_LAZY_CONTAINER.test(text.slice(text.lastIndexOf('\n') + 1)) ? '\n\n' : '\n';
    text += field;
  }
  return text ? `\n\n${text}` : '';
}

/**
 * Write `values` to `ctx.enrich` in their key order, so the framework's store — its values, its
 * `notice` kind tag, and its key order — is the one {@link enrichmentTrailer} measured.
 */
export function applyEnrichment(ctx: Context, values: EnrichmentValues): void {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'notice') ctx.enrich.notice(String(value));
    else ctx.enrich({ [key]: value });
  }
}

/**
 * Both surfaces of the response a tool would return: `parsed` is the handler's result as the output
 * schema parses it, `format` the tool's own formatter. `structuredContent` is the parsed result with
 * the enrichment merged in, serialized; `content[]` is the formatter's blocks and the trailer,
 * joined by a newline as a client concatenates them — one byte more than the blocks alone.
 */
export function measureResponse<T extends object>(
  parsed: T,
  format: (result: T) => ContentBlock[],
  enrichment: EnrichmentValues,
): SurfaceBytes {
  const blocks = format(parsed).map((block) =>
    block.type === 'text' ? block.text : JSON.stringify(block),
  );
  const trailer = enrichmentTrailer(enrichment);
  return {
    structured: utf8(JSON.stringify({ ...parsed, ...enrichment })),
    content: utf8((trailer ? [...blocks, trailer] : blocks).join('\n')),
  };
}

/** Whether both surfaces fit {@link RESPONSE_BUDGET_BYTES}. */
export const fitsBudget = (size: SurfaceBytes) =>
  size.structured <= RESPONSE_BUDGET_BYTES && size.content <= RESPONSE_BUDGET_BYTES;

/**
 * The largest `n` in `1..count` for which `fits(n)` holds, by binary search — responses grow with
 * every record kept, so `fits` is monotone. Returns 1 when nothing fits: the first record always
 * survives, whatever its size.
 */
export function largestFitting(count: number, fits: (n: number) => boolean): number {
  let low = 1;
  let high = count;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** What a paged tool needs to size a page against the budget. */
export interface PageFit<P> {
  /** Posts on a page, the ones riding outside `limit` included. */
  count: (page: P) => number;
  /** The caller's `limit`. */
  limit: number;
  /** The `limit` that returns the first `kept` posts of `page` — fewer than `kept` when a pin rides along. */
  limitFor: (page: P, kept: number) => number;
  /**
   * Both surfaces of the response built from the first `kept` posts of `page`; `requested`, when
   * set, is the `limit` the budget disclosure names.
   */
  measure: (page: P, kept: number, requested?: number) => SurfaceBytes;
  /** Ask Bluesky again for this page with a smaller `limit`, same cursor and filters. */
  refetch: (limit: number) => Promise<P>;
}

/** The page a paged tool returns, and — when the budget cut it — the `limit` that page was asked for. */
export interface FittedPage<P> {
  page: P;
  requested?: number;
}

/**
 * Hold a page to the budget without splitting an upstream response. When `first` would overflow, the
 * largest prefix of it that fits sets `k`, and Bluesky is asked again at `limit: k`; that response is
 * returned whole, so its cursor continues after the last post it carries. When the answer still
 * overflows — a ranked feed reranks on every call — `k` is predicted again from that answer and
 * strictly decreases. At most {@link MAX_BUDGET_REFETCHES} re-requests are made, the last at
 * `limit: 1`, and a one-post page is returned whatever its size. A caller who asked for one post is
 * never re-requested.
 */
export async function fitPage<P>(first: P, fit: PageFit<P>): Promise<FittedPage<P>> {
  if (fitsBudget(fit.measure(first, fit.count(first)))) return { page: first };
  let page = first;
  let requested = fit.limit;
  for (let attempt = 1; attempt <= MAX_BUDGET_REFETCHES && requested > 1; attempt++) {
    const current = page;
    const kept = largestFitting(fit.count(current), (n) =>
      fitsBudget(fit.measure(current, n, fit.limitFor(current, n))),
    );
    const next =
      attempt === MAX_BUDGET_REFETCHES
        ? 1
        : Math.max(1, Math.min(fit.limitFor(current, kept), requested - 1));
    page = await fit.refetch(next);
    requested = next;
    /** Measured with the limit its notice will name — a feed can answer with fewer posts than that. */
    if (fitsBudget(fit.measure(page, fit.count(page), next))) break;
  }
  return requested < fit.limit ? { page, requested } : { page };
}

/** What one page of a paged tool says about itself, beyond its posts. */
export interface PageDisclosure {
  /** The page's cursor — its presence is what `truncated` / `shown` / `cap` report. */
  cursor: string | undefined;
  /** The notice for an empty page that has no cursor. */
  empty: string;
  /** Tool-specific fields, written after `totalReturned`. */
  extra?: EnrichmentValues;
  /** The caller's `limit`. */
  limit: number;
  /** Guidance when a cursor came back. */
  more: string;
  /** Plural noun for the records — "posts", "quotes". */
  noun: string;
  /** The `limit` the budget re-requested the page at, when it did. */
  requested: number | undefined;
  /** Records on the page. */
  shown: number;
}

/**
 * The enrichment a paged post tool writes for one page, in the order the fields are written: the
 * count, the tool's own fields, the cursor disclosure (`truncated` / `shown` / `cap`, keyed on a
 * returned cursor alone), `budgetCapped`, and one notice — `notice` is last-wins in the framework's
 * store, so the cursor guidance or the empty-page notice and the budget sentence are composed into
 * it. The budget sentence says how far the page was cut, why, and that the cursor still continues
 * from where the page ends, which holds however the endpoint pages, since the posts and the cursor
 * come from one response.
 */
export function pageEnrichment(page: PageDisclosure): Record<string, EnrichmentValue> {
  const { cursor, limit, noun, requested, shown } = page;
  const enrichment: Record<string, EnrichmentValue> = { totalReturned: shown, ...page.extra };
  if (cursor) Object.assign(enrichment, { truncated: true, shown, cap: limit });
  if (requested !== undefined) enrichment.budgetCapped = true;
  const notice = [
    cursor ? page.more : shown === 0 ? page.empty : '',
    requested === undefined
      ? ''
      : `This page holds ${shown} of the ${limit} ${noun} asked for: a page of ${limit} would have run ` +
        `past this server's ${RESPONSE_BUDGET_BYTES.toLocaleString('en-US')}-byte response budget. ` +
        `Bluesky was asked again with limit ${requested}, so these ${noun} and the cursor come from ` +
        'one response and the cursor picks up where they end. A smaller limit pages in steps that fit.',
  ]
    .filter(Boolean)
    .join(' ');
  if (notice) enrichment.notice = notice;
  return enrichment;
}

/** A paged tool's response for one page: what the handler returns, and the enrichment it writes. */
export interface PagedResponse<R> {
  enrichment: EnrichmentValues;
  output: R;
}

/**
 * Run {@link fitPage} for a paged tool and return its response: `respond` builds the response for a
 * page — once per candidate to measure it through the tool's own output schema and formatter, and
 * once more for the page returned, whose enrichment is then written to `ctx`.
 */
export async function respondWithinBudget<P, R, O extends object>(
  ctx: Context,
  first: P,
  options: Omit<PageFit<P>, 'limitFor' | 'measure'> & {
    format: (result: O) => ContentBlock[];
    /** The `limit` that returns the first `kept` posts of a page. Defaults to `kept`. */
    limitFor?: PageFit<P>['limitFor'];
    /** The response for `page`; `requested` is set when the budget re-requested it. */
    respond: (page: P, requested?: number) => PagedResponse<R>;
    schema: { parse: (value: unknown) => O };
    /** `page` cut to its first `kept` posts. */
    slice: (page: P, kept: number) => P;
  },
): Promise<R> {
  const { format, respond, schema, slice, limitFor = (_page, kept) => kept, ...fit } = options;
  const { page, requested } = await fitPage(first, {
    ...fit,
    limitFor,
    measure: (p, kept, req) => {
      const response = respond(slice(p, kept), req);
      return measureResponse(schema.parse(response.output), format, response.enrichment);
    },
  });
  const { output, enrichment } = respond(page, requested);
  applyEnrichment(ctx, enrichment);
  return output;
}

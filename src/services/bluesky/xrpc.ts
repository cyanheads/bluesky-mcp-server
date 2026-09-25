/**
 * @fileoverview XRPC request plumbing shared by the keyless AppView client and the post-search
 * session: request identity, URL building, and reading a failed request's status and XRPC error
 * envelope — with any HTML block page Bluesky's edge answered kept out of the error.
 * @module services/bluesky/xrpc
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { McpError } from '@cyanheads/mcp-ts-core/errors';

/** Request timeout in milliseconds. */
export const TIMEOUT_MS = 15_000;

/**
 * User-Agent header sent on every request, derived from the package manifest so a release cannot
 * ship a stale version string.
 */
export const USER_AGENT = `${config.mcpServerName}/${config.mcpServerVersion}`;

/** Query parameters for an XRPC GET; undefined and empty values are left off the URL. */
export type XrpcParams = Record<string, string | number | boolean | undefined>;

/** Build a full XRPC URL with query params. */
export function xrpcUrl(base: string, lexicon: string, params: XrpcParams): string {
  const url = new URL(`${base}/xrpc/${lexicon}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** An HTML document, as opposed to the XRPC JSON every Bluesky endpoint answers with. */
export const HTML_DOCUMENT = /^\s*<(!DOCTYPE\s+html|html[\s>])/i;

/**
 * Drop an HTML page from a failed request's error data. The edge in front of Bluesky refuses some
 * requests with an HTML block page rather than an XRPC envelope, and the framework captures that
 * body into `data.body` / `data.responseBody`, which reach the client. The status and the redacted
 * URL in the message already say everything the page does.
 */
export function withoutHtmlBody(err: McpError): McpError {
  const data = err.data as Record<string, unknown> | undefined;
  if (typeof data?.body !== 'string' || !HTML_DOCUMENT.test(data.body)) return err;
  const { body: _body, responseBody: _responseBody, ...rest } = data;
  return new McpError(err.code, err.message, rest);
}

/** The XRPC error envelope a failed request carried, when its body was one. */
export function xrpcError(err: McpError): { error?: string; message?: string } {
  const body = (err.data as { body?: unknown } | undefined)?.body;
  if (typeof body !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object'
      ? (parsed as { error?: string; message?: string })
      : {};
  } catch {
    return {};
  }
}

/** HTTP status of a failed upstream request; undefined for anything that never got one. */
export function httpStatus(err: unknown): number | undefined {
  if (!(err instanceof McpError)) return;
  const status = (err.data as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** "InvalidToken: Token has expired", falling back to the status when the body was no envelope. */
export function describeRejection(err: unknown): string {
  const { error, message } = err instanceof McpError ? xrpcError(err) : {};
  return [error, message].filter(Boolean).join(': ') || `HTTP ${httpStatus(err) ?? 'error'}`;
}

/**
 * @fileoverview The app-password session post search runs on. Bluesky's edge refuses
 * `app.bsky.feed.searchPosts` without a signed-in account, so search goes through the configured
 * account's PDS. The session is created on the first search and never at startup, shared by every
 * caller of the process, renewed once when Bluesky refuses its token, and never retried: each
 * `createSession` spends one of the account's few daily logins. A login or refresh answered 429
 * holds every search off, without a request, until the limit lifts.
 * @module services/bluesky/search-session
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  rateLimited,
  serviceUnavailable,
  unauthorized,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, logger, withExtra } from '@cyanheads/mcp-ts-core/utils';
import {
  describeRejection,
  httpStatus,
  TIMEOUT_MS,
  USER_AGENT,
  withoutHtmlBody,
  xrpcError,
} from './xrpc.js';

/**
 * @internal Where an app-password session is created. `com.atproto.server.createSession` answered
 * `ratelimit-policy: 10;w=86400` per identifier (measured 2026-09-25, stricter than the documented
 * limit), so a login happens on the first search and never at startup, and none is ever retried.
 */
const ENTRYWAY_URL = 'https://bsky.social';

/**
 * @internal How long a session call answered 429 holds off every search when the answer carried no
 * `ratelimit-reset`. Nothing gets past the limit sooner, and each search in between would only
 * repeat the refused call.
 */
const LOGIN_LIMIT_FALLBACK_MS = 15 * 60_000;

/**
 * @internal Service the session account's PDS forwards an `app.bsky.*` read to. Bluesky's PDS
 * already defaults to this AppView; naming it keeps the route independent of that default.
 */
const APPVIEW_PROXY = 'did:web:api.bsky.app#bsky_appview';

/** App-password credentials that enable post search. */
export interface SearchCredentials {
  appPassword: string;
  /** Handle, DID, or email. */
  identifier: string;
}

/** Where an authenticated read goes, and the headers that authenticate it and route it to the AppView. */
export interface SessionRoute {
  headers: Record<string, string>;
  /** Origin of the account's PDS. */
  serviceUrl: string;
}

/** @internal A live session: its tokens and the PDS that serves the account. */
interface Session {
  accessJwt: string;
  refreshJwt: string;
  serviceUrl: string;
}

/** @internal The fields of `createSession` / `refreshSession` output this client reads. */
interface RawSession {
  accessJwt: string;
  didDoc?: {
    service?: Array<{ id?: string; serviceEndpoint?: unknown; type?: string }>;
  };
  refreshJwt: string;
}

/** @internal The account's PDS from the DID document a session carries; https only, since the tokens go there. */
function pdsEndpoint(didDoc: RawSession['didDoc']): string | undefined {
  const pds = didDoc?.service?.find(
    (s) => s.id?.endsWith('#atproto_pds') && s.type === 'AtprotoPersonalDataServer',
  )?.serviceEndpoint;
  return typeof pds === 'string' && pds.startsWith('https://')
    ? pds.replace(/\/+$/, '')
    : undefined;
}

/**
 * @internal Whether the PDS refused the bearer token itself — expired, revoked, or malformed — as
 * opposed to refusing the request it rode on.
 */
function isTokenRejection(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 401) return true;
  return (
    status === 400 &&
    err instanceof McpError &&
    /^(ExpiredToken|InvalidToken)$/.test(xrpcError(err).error ?? '')
  );
}

/** @internal A 400 or 401 from a session call: Bluesky refused the credentials or the refresh token. */
function isCredentialRejection(err: unknown): boolean {
  const status = httpStatus(err);
  return status === 400 || status === 401;
}

/** @internal `search_auth_failed`, with the calling tool's declared recovery. */
function searchAuthFailed(ctx: Context, message: string): McpError {
  return unauthorized(message, {
    reason: 'search_auth_failed',
    ...ctx.recoveryFor('search_auth_failed'),
  });
}

/**
 * @internal When a 429 from a session call lifts: its `ratelimit-reset` (epoch seconds, as Bluesky
 * sends it) when that names a future time, otherwise {@link LOGIN_LIMIT_FALLBACK_MS} from now.
 */
function limitLiftsAt(err: McpError): number {
  const headers = (err.data as { headers?: Record<string, string> } | undefined)?.headers;
  const resetMs = Number(headers?.['ratelimit-reset']) * 1000;
  const now = Date.now();
  return Number.isFinite(resetMs) && resetMs > now ? resetMs : now + LOGIN_LIMIT_FALLBACK_MS;
}

/**
 * @internal `search_login_limited`, naming when searching can resume. It carries no request's
 * identity, since every search waiting on the limited call receives this same error.
 */
function searchLoginLimited(until: number): McpError {
  const at = new Date(until).toISOString();
  return rateLimited(
    `Bluesky's login limit for the account this server searches as is used up until ${at}.`,
    {
      reason: 'search_login_limited',
      retryAt: at,
      recovery: {
        hint: `Search again after ${at}; read posts on a topic meanwhile with bsky_get_trending, then bsky_get_feed on a trend feedUri.`,
      },
    },
  );
}

/** @internal The route a session's reads take: its PDS, its access token, and the AppView proxy. */
function routeOf(session: Session): SessionRoute {
  return {
    serviceUrl: session.serviceUrl,
    headers: { Authorization: `Bearer ${session.accessJwt}`, 'atproto-proxy': APPVIEW_PROXY },
  };
}

/**
 * @internal A failed session call, fit to hand to every caller waiting on it: no HTML body, and
 * none of the identity of the request that happened to start the call, since concurrent searches
 * share the one call and its failure.
 */
function sharedSessionError(err: McpError): McpError {
  const scrubbed = withoutHtmlBody(err);
  const {
    requestId: _requestId,
    operation: _operation,
    ...rest
  } = (scrubbed.data as Record<string, unknown> | undefined) ?? {};
  return new McpError(scrubbed.code, scrubbed.message, rest);
}

/**
 * The shared search session. At most one session operation — a login or a renewal — is in flight
 * at a time, and every search that needs one waits on it rather than starting its own.
 */
export class SearchSession {
  /** The last session that worked; cleared while a renewal is in flight. */
  private current: Session | undefined;
  /** An in-flight create or renew that concurrent searches wait on instead of starting their own. */
  private pending: Promise<Session> | undefined;
  /**
   * Set once Bluesky rejects the configured login. Credentials come from the environment and
   * cannot change for the life of the process, and every `createSession` spends one of the
   * account's ten daily logins, so a rejected login is not attempted again.
   */
  private loginRejection: string | undefined;
  /**
   * Set when a login or refresh is answered 429: until this epoch time every search fails as
   * `search_login_limited` without a request. Unlike {@link loginRejection} it lifts on its own, and
   * the session it interrupted is kept, so a limited refresh is retried as a refresh.
   */
  private limitedUntil: number | undefined;

  constructor(private readonly credentials: SearchCredentials) {}

  /**
   * Run an authenticated read on the shared session. A token the PDS refuses is renewed once —
   * refreshed, or re-created when the refresh itself is refused — and the read sent again; a
   * second refusal ends the attempt as `search_auth_failed`.
   */
  async run<T>(ctx: Context, send: (route: SessionRoute) => Promise<T>): Promise<T> {
    this.assertNotLimited();
    const session = await (this.current ?? this.singleFlight(() => this.create(ctx)));
    try {
      return await send(routeOf(session));
    } catch (err) {
      if (!isTokenRejection(err)) throw err;
    }
    const renewed = await this.renew(session, ctx);
    try {
      return await send(routeOf(renewed));
    } catch (err) {
      if (isTokenRejection(err)) {
        throw searchAuthFailed(
          ctx,
          `Bluesky refused the search session it had just issued (${describeRejection(err)}).`,
        );
      }
      throw err;
    }
  }

  /**
   * Replace a session whose token was refused. A request that failed on a session some other
   * request has already replaced takes the replacement rather than renewing twice — the refresh
   * token rotates on every use.
   */
  private renew(stale: Session, ctx: Context): Promise<Session> {
    if (this.current && this.current !== stale) return Promise.resolve(this.current);
    this.current = undefined;
    return this.singleFlight(async () => {
      try {
        return await this.refresh(stale, ctx);
      } catch (err) {
        if (!isCredentialRejection(err)) {
          // Transient: the refresh token still works, so the next search refreshes, not logs in.
          this.current ??= stale;
          throw err;
        }
      }
      return this.create(ctx);
    });
  }

  /** Throw `search_login_limited` while a login limit holds; clear it once it has lifted. */
  private assertNotLimited(): void {
    if (this.limitedUntil === undefined) return;
    if (Date.now() < this.limitedUntil) throw searchLoginLimited(this.limitedUntil);
    this.limitedUntil = undefined;
  }

  /** Run one session operation at a time; concurrent callers share its result. */
  private singleFlight(start: () => Promise<Session>): Promise<Session> {
    this.pending ??= start()
      .then((session) => {
        this.current = session;
        return session;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  /**
   * One POST to a session endpoint — no retry, and no caller signal, since the session outlives
   * the request that happened to start it. Refused outright while a login limit holds; a 429 sets
   * that limit.
   */
  private async call(
    url: string,
    ctx: Context,
    init: { authorization?: string; body?: unknown },
  ): Promise<{ headers: Headers; raw: RawSession }> {
    this.assertNotLimited();
    const response = await fetchWithTimeout(url, TIMEOUT_MS, ctx, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.authorization ? { Authorization: init.authorization } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      errorHeaders: ['ratelimit-reset'],
    }).catch((err: unknown) => {
      if (!(err instanceof McpError)) throw err;
      if (httpStatus(err) === 429) {
        this.limitedUntil = limitLiftsAt(err);
        throw searchLoginLimited(this.limitedUntil);
      }
      throw sharedSessionError(err);
    });
    const text = await response.text();
    try {
      return { headers: response.headers, raw: JSON.parse(text) as RawSession };
    } catch {
      /** A parse error would quote the body back, and the body here may be an HTML page. */
      throw serviceUnavailable(
        'Bluesky answered a session request with something other than JSON.',
      );
    }
  }

  /** Log in with the app password. Spends one of the account's daily logins. */
  private async create(ctx: Context): Promise<Session> {
    if (this.loginRejection) throw searchAuthFailed(ctx, this.loginRejection);
    const { identifier, appPassword } = this.credentials;
    let result: { headers: Headers; raw: RawSession };
    try {
      result = await this.call(`${ENTRYWAY_URL}/xrpc/com.atproto.server.createSession`, ctx, {
        body: { identifier, password: appPassword },
      });
    } catch (err) {
      if (!isCredentialRejection(err)) throw err;
      this.loginRejection = `Bluesky rejected the login configured for search (${describeRejection(err)}).`;
      throw searchAuthFailed(ctx, this.loginRejection);
    }
    /** Server-side only: `ctx.log` would carry this to every client of a shared instance. */
    logger.info(
      'Created a Bluesky session for post search.',
      withExtra(ctx, {
        operation: 'SearchSession.create',
        loginsRemaining: result.headers.get('ratelimit-remaining') ?? 'not reported',
        loginPolicy: result.headers.get('ratelimit-policy') ?? 'not reported',
      }),
    );
    return {
      accessJwt: result.raw.accessJwt,
      refreshJwt: result.raw.refreshJwt,
      serviceUrl: pdsEndpoint(result.raw.didDoc) ?? ENTRYWAY_URL,
    };
  }

  /** Trade the refresh token for a new pair. The refresh token rotates. */
  private async refresh(stale: Session, ctx: Context): Promise<Session> {
    const { raw } = await this.call(
      `${stale.serviceUrl}/xrpc/com.atproto.server.refreshSession`,
      ctx,
      { authorization: `Bearer ${stale.refreshJwt}` },
    );
    logger.info(
      'Refreshed the Bluesky search session.',
      withExtra(ctx, { operation: 'SearchSession.refresh' }),
    );
    return {
      accessJwt: raw.accessJwt,
      refreshJwt: raw.refreshJwt,
      serviceUrl: pdsEndpoint(raw.didDoc) ?? stale.serviceUrl,
    };
  }
}

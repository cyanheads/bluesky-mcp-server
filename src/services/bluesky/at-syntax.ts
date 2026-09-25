/**
 * @fileoverview AT Protocol identifier, URI, and datetime syntax patterns, the search filters'
 * language, hostname, and URL patterns with the rewrites that go with them, and the one parser that
 * reads every form an actor, post, or feed reference arrives in. The patterns are shared by the
 * MCP tool and resource input schemas, so malformed values are rejected locally — and advertised as
 * JSON Schema `pattern` constraints — rather than reaching the AppView, which answers a bad
 * identifier with a generic 400 and silently ignores an unparseable date filter. The parser is what
 * each handler runs its input through before any request, rewriting a shared bsky.app link or an
 * `@handle` into the value the AppView takes.
 * @module services/bluesky/at-syntax
 */

/** @internal DID — `did:<method>:<method-specific-id>`, per the AT Protocol DID syntax. */
const DID = 'did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]';

/** @internal Handle — a dotted domain name; two or more labels, TLD starting with a letter. */
const HANDLE =
  '(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';

/** @internal Collection NSID — reverse-DNS name, e.g. `app.bsky.feed.post`. */
const NSID = '[a-zA-Z]+(?:\\.[a-zA-Z0-9-]+)+';

/** @internal Record key — the trailing segment of an AT-URI. */
const RKEY = '[a-zA-Z0-9._~:-]{1,512}';

/**
 * @internal What may follow a bsky.app path and is dropped: one trailing slash (bsky.app itself
 * redirects to the slashless URL), then a query or fragment that another app appended. None of the
 * three segments above can contain `/`, `?`, or `#`, so the tail can never swallow part of one.
 */
const URL_TAIL = '/?(?:[?#].*)?';

/** @internal The bsky.app page for an account, up to the actor segment. */
const PROFILE_URL = `https://bsky\\.app/profile/(?:${HANDLE}|${DID})`;

/** Collection NSID of a post record — the only collection `app.bsky.feed.getQuotes` answers for. */
export const POST_COLLECTION = 'app.bsky.feed.post';

/** Collection NSID of a feed generator record — the only collection `app.bsky.feed.getFeed` reads. */
export const FEED_GENERATOR_COLLECTION = 'app.bsky.feed.generator';

/**
 * An actor as a caller may have it: a handle or DID, a handle with the leading `@` Bluesky shows it
 * with, or the bsky.app page of the account. The last two are rewritten by {@link actorFromRef}.
 */
export const ACTOR_REF_REGEX = new RegExp(
  `^(?:${HANDLE}|${DID}|@${HANDLE}|${PROFILE_URL}${URL_TAIL})$`,
);

/** Validation message paired with {@link ACTOR_REF_REGEX}. */
export const ACTOR_REF_MESSAGE =
  'Must be a handle such as "alice.bsky.social" (a leading "@" is fine), a DID such as "did:plc:z72i7hdynmk6r22z27h6tvur", or the account\'s bsky.app page, https://bsky.app/profile/<handle-or-did> — no spaces, and a handle needs a dot. A post or feed URL names a record, not an account.';

/**
 * A record reference for the thread tool: any full AT-URI, or the bsky.app page of a post, which
 * {@link atUriFromRef} rewrites to `at://<handle-or-did>/app.bsky.feed.post/<rkey>`.
 */
export const AT_URI_REF_REGEX = new RegExp(
  `^(?:at://(?:${HANDLE}|${DID})/${NSID}/${RKEY}|${PROFILE_URL}/post/${RKEY}${URL_TAIL})$`,
);

/** Validation message paired with {@link AT_URI_REF_REGEX}. */
export const AT_URI_REF_MESSAGE =
  'Must be a full AT-URI of the form at://<handle-or-did>/<collection>/<rkey>, e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3lc4gpsxr3c2q", or a bsky.app post URL, https://bsky.app/profile/<handle-or-did>/post/<rkey>. Copy it from the "uri" field of a post returned by bsky_get_author_feed or bsky_get_feed.';

/** A post reference: a post AT-URI, or the bsky.app page of a post. No other collection. */
export const POST_URI_REF_REGEX = new RegExp(
  `^(?:at://(?:${HANDLE}|${DID})/app\\.bsky\\.feed\\.post/${RKEY}|${PROFILE_URL}/post/${RKEY}${URL_TAIL})$`,
);

/** Validation message paired with {@link POST_URI_REF_REGEX}. */
export const POST_URI_REF_MESSAGE =
  'Must be a post AT-URI, at://<handle-or-did>/app.bsky.feed.post/<rkey> (e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l"), or a bsky.app post URL, https://bsky.app/profile/<handle-or-did>/post/<rkey>. A feed, profile, or list address is not a post. Copy it from the "uri" field of a post returned by bsky_get_author_feed or bsky_get_feed.';

/**
 * A feed reference in either form an agent meets one: the generator record's AT-URI, or the
 * bsky.app page that shows the feed, which is what a shared link and a trend's `link` carry.
 * Any other collection is refused here because the AppView answers a post AT-URI with the same
 * `could not find feed` as a missing feed, and an AT-URI with no record key with a 500.
 */
export const FEED_REF_REGEX = new RegExp(
  `^(?:at://(?:${HANDLE}|${DID})/app\\.bsky\\.feed\\.generator/${RKEY}|${PROFILE_URL}/feed/${RKEY}${URL_TAIL})$`,
);

/** Validation message paired with {@link FEED_REF_REGEX}. */
export const FEED_REF_MESSAGE =
  'Must be a feed generator AT-URI, at://<handle-or-did>/app.bsky.feed.generator/<rkey> (e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot"), or the bsky.app page that shows the feed, https://bsky.app/profile/<handle-or-did>/feed/<rkey>. A post AT-URI (app.bsky.feed.post) is not a feed — read a post with bsky_get_post_thread.';

/** What a reference names once parsed: an account, or one record by its AT-URI parts. */
export type BlueskyRef =
  | { kind: 'actor'; actor: string }
  | { kind: 'record'; authority: string; collection: string; rkey: string };

/** @internal Bare handle or DID, or a handle behind one leading `@`. */
const ACTOR_FORM = new RegExp(`^(?:(${HANDLE}|${DID})|@(${HANDLE}))$`);

/** @internal Full AT-URI, captured into authority, collection, and record key. */
const AT_URI_FORM = new RegExp(`^at://(${HANDLE}|${DID})/(${NSID})/(${RKEY})$`);

/** @internal A bsky.app profile page, or a post or feed page below it. */
const BSKY_APP_FORM = new RegExp(
  `^https://bsky\\.app/profile/(${HANDLE}|${DID})(?:/(post|feed)/(${RKEY}))?${URL_TAIL}$`,
);

/** @internal The record collection each bsky.app page kind shows. */
const PAGE_COLLECTION = { post: POST_COLLECTION, feed: FEED_GENERATOR_COLLECTION } as const;

/**
 * Parse any actor, post, or feed reference — a handle or DID (bare or behind `@`), an AT-URI, or a
 * bsky.app profile, post, or feed page — into what it names. Undefined for anything else, including
 * every other bsky.app path. Every value the 0.4.0 patterns accepted parses to the same meaning it
 * had: a bare handle or DID to itself, an AT-URI to its own three parts.
 */
export function parseBlueskyRef(value: string): BlueskyRef | undefined {
  const actor = ACTOR_FORM.exec(value);
  const bare = actor?.[1] ?? actor?.[2];
  if (bare) return { kind: 'actor', actor: bare };
  const uri = AT_URI_FORM.exec(value);
  if (uri?.[1] && uri[2] && uri[3]) {
    return { kind: 'record', authority: uri[1], collection: uri[2], rkey: uri[3] };
  }
  const page = BSKY_APP_FORM.exec(value);
  if (!page?.[1]) return;
  const kind = page[2] as keyof typeof PAGE_COLLECTION | undefined;
  return kind && page[3]
    ? { kind: 'record', authority: page[1], collection: PAGE_COLLECTION[kind], rkey: page[3] }
    : { kind: 'actor', actor: page[1] };
}

/**
 * The handle or DID an actor reference names — `@alice.bsky.social` and
 * `https://bsky.app/profile/alice.bsky.social` both become `alice.bsky.social`. A value that names
 * no account is returned as-is; the input pattern already refused it.
 */
export function actorFromRef(value: string): string {
  const ref = parseBlueskyRef(value);
  return ref?.kind === 'actor' ? ref.actor : value;
}

/**
 * The AT-URI a record reference names — a bsky.app post page becomes
 * `at://<handle-or-did>/app.bsky.feed.post/<rkey>`, keeping the handle it carried. An AT-URI comes
 * back unchanged, as does a value that names no record.
 */
export function atUriFromRef(value: string): string {
  const ref = parseBlueskyRef(value);
  return ref?.kind === 'record' ? `at://${ref.authority}/${ref.collection}/${ref.rkey}` : value;
}

/** The two parts of a record reference that address it once its collection is known. */
export interface RecordRef {
  /** Handle or DID that owns the record. */
  authority: string;
  /** Record key. */
  rkey: string;
}

/** Split a feed AT-URI or bsky.app feed URL into authority and record key; undefined for anything else. */
export function parseFeedRef(ref: string): RecordRef | undefined {
  return recordIn(ref, FEED_GENERATOR_COLLECTION);
}

/** Split a post AT-URI or bsky.app post URL into authority and record key; undefined for anything else. */
export function parsePostRef(ref: string): RecordRef | undefined {
  return recordIn(ref, POST_COLLECTION);
}

/** @internal The authority and record key of a reference to a record in `collection`. */
function recordIn(value: string, collection: string): RecordRef | undefined {
  const ref = parseBlueskyRef(value);
  return ref?.kind === 'record' && ref.collection === collection
    ? { authority: ref.authority, rkey: ref.rkey }
    : undefined;
}

/** The generator record's AT-URI for a feed reference. */
export function feedGeneratorUri({ authority, rkey }: RecordRef): string {
  return `at://${authority}/${FEED_GENERATOR_COLLECTION}/${rkey}`;
}

/** At least one non-whitespace character — a blank or all-space value is not a query. */
export const NON_BLANK_REGEX = /\S/;

/** Validation message paired with {@link NON_BLANK_REGEX}. */
export const NON_BLANK_MESSAGE = 'Must contain at least one non-whitespace character.';

/** @internal Zero-padded calendar date with bounded month and day. */
const ISO_DATE = '\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';

/** @internal Date-only form, where the AppView also honours an unpadded month or day. */
const ISO_DATE_LOOSE = '\\d{4}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\\d|3[01])';

/** @internal Wall-clock time; seconds and fractional seconds optional. */
const ISO_TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?';

/** @internal UTC designator or numeric offset. */
const ISO_ZONE = '(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)';

/**
 * Calendar date (`YYYY-M-D`, padding optional) or datetime
 * (`YYYY-MM-DDTHH:MM[:SS[.sss]][Z|±HH:MM]`, padding required) — the two forms the
 * AppView's search date filters honour. Anything else is dropped upstream without an
 * error, returning unfiltered results that read as filtered; an unpadded month or day
 * in the datetime form is dropped that way even though the date-only form accepts it.
 */
export const ISO_DATETIME_REGEX = new RegExp(
  `^(?:${ISO_DATE_LOOSE}|${ISO_DATE}T${ISO_TIME}${ISO_ZONE}?)$`,
);

/** Validation message paired with {@link ISO_DATETIME_REGEX}. */
export const ISO_DATETIME_MESSAGE =
  'Must be a calendar date ("2025-01-01") or a zero-padded ISO 8601 datetime ("2025-01-01T00:00:00Z"). A datetime with an unpadded month or day ("2025-1-1T00:00:00Z") is silently ignored by Bluesky and returns unfiltered results.';

/**
 * A language tag Bluesky search can filter by — a two-letter primary subtag, in either case,
 * followed by any number of alphanumeric subtags, so "en", "EN", "en-US", "pt-BR", and
 * "zh-Hant-TW" all pass.
 *
 * The boundary is the primary subtag's length, measured against the live search: every
 * three-letter one is dropped and the unfiltered result set returned with a 200 —
 * unassigned codes ("qqq"), languages with no two-letter code ("fil", "haw", "tok"), and
 * the three-letter forms of filterable ones ("eng", "jpn") alike — while every two-letter
 * one is applied, an unassigned one ("xx") included, which honestly returns nothing.
 * Later subtags are accepted and ignored upstream ("en-US" filters as "en"). A registry
 * or the app's own language list would not draw this line, since both hold three-letter
 * languages search drops. Case is accepted because tags are case-insensitive; Bluesky
 * answers an uppercase primary subtag with 400, so {@link searchLanguage} lowercases it.
 */
export const BCP47_LANGUAGE_REGEX = /^[a-zA-Z]{2}(?:-[a-zA-Z0-9]{1,8})*$/;

/** Validation message paired with {@link BCP47_LANGUAGE_REGEX}. */
export const BCP47_LANGUAGE_MESSAGE =
  'Must be a language tag with a two-letter ISO 639-1 code, optionally followed by hyphen-separated subtags — "en", "ja", "es", "en-US", "pt-BR", "zh-Hant". Bluesky search filters only by a two-letter code: it ignores a three-letter one such as "fil" or "eng" and returns unfiltered results, so those are refused here. A language name such as "english" is not a tag.';

/** A validated language tag as search takes it: the primary subtag lowercased, the rest unchanged. */
export function searchLanguage(tag: string): string {
  return tag.slice(0, 2).toLowerCase() + tag.slice(2);
}

/**
 * A bare hostname, for the search `domain` filter — the handle grammar, which is a
 * hostname's. Anything with a scheme, path, or port fails it, since Bluesky answers those
 * with 200 and no matches rather than an error.
 */
export const DOMAIN_REGEX = new RegExp(`^${HANDLE}$`);

/** Validation message paired with {@link DOMAIN_REGEX}. */
export const DOMAIN_MESSAGE =
  'Must be a bare hostname such as "github.com" — no scheme, path, or port. To match one exact link, pass it as url instead.';

/**
 * A validated domain as search takes it: lowercased, and without a leading "www." that
 * has a domain behind it. Bluesky's index stores links without "www.", so "www.github.com"
 * matches nothing while "github.com" matches "www.github.com" links too.
 */
export function searchDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\.(?=[^.]+\.)/, '');
}

/** An absolute http(s) URL, for the search `url` filter; Bluesky answers anything else with 400. */
export const HTTP_URL_REGEX = /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/;

/** Validation message paired with {@link HTTP_URL_REGEX}. */
export const HTTP_URL_MESSAGE =
  'Must be an absolute http(s) URL such as "https://github.com/bluesky-social/atproto". To match every link to a site, pass its hostname as domain instead.';

/**
 * @fileoverview AT Protocol identifier, URI, and datetime syntax patterns.
 * Shared by the MCP tool and resource input schemas so malformed values are
 * rejected locally — and advertised as JSON Schema `pattern` constraints — rather
 * than reaching the AppView, which answers a bad identifier with a generic 400
 * and silently ignores an unparseable date filter.
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
 * AT identifier — a handle or a DID. Every `actor` input accepts either form;
 * the AppView rejects anything else with `Invalid AT identifier`.
 */
export const AT_IDENTIFIER_REGEX = new RegExp(`^(?:${HANDLE}|${DID})$`);

/** Validation message paired with {@link AT_IDENTIFIER_REGEX}. */
export const AT_IDENTIFIER_MESSAGE =
  'Must be a handle such as "alice.bsky.social" or a DID such as "did:plc:z72i7hdynmk6r22z27h6tvur" — no leading "@", no spaces, and a handle needs a dot.';

/** AT-URI — `at://<handle-or-did>/<collection>/<rkey>`. */
export const AT_URI_REGEX = new RegExp(`^at://(?:${HANDLE}|${DID})/${NSID}/${RKEY}$`);

/** Validation message paired with {@link AT_URI_REGEX}. */
export const AT_URI_MESSAGE =
  'Must be a full AT-URI of the form at://<handle-or-did>/<collection>/<rkey>, e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3lc4gpsxr3c2q". Copy it from the "uri" field of a post returned by bsky_get_author_feed or bsky_get_feed.';

/** Collection NSID of a feed generator record — the only collection `app.bsky.feed.getFeed` reads. */
export const FEED_GENERATOR_COLLECTION = 'app.bsky.feed.generator';

/**
 * A feed reference in either form an agent meets one: the generator record's AT-URI, or the
 * bsky.app page that shows the feed, which is what a shared link and a trend's `link` carry.
 * Any other collection is refused here because the AppView answers a post AT-URI with the same
 * `could not find feed` as a missing feed, and an AT-URI with no record key with a 500.
 */
export const FEED_REF_REGEX = new RegExp(
  `^(?:at://(${HANDLE}|${DID})/app\\.bsky\\.feed\\.generator/(${RKEY})|https://bsky\\.app/profile/(${HANDLE}|${DID})/feed/(${RKEY}))$`,
);

/** Validation message paired with {@link FEED_REF_REGEX}. */
export const FEED_REF_MESSAGE =
  'Must be a feed generator AT-URI, at://<handle-or-did>/app.bsky.feed.generator/<rkey> (e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot"), or the bsky.app page that shows the feed, https://bsky.app/profile/<handle-or-did>/feed/<rkey>. A post AT-URI (app.bsky.feed.post) is not a feed — read a post with bsky_get_post_thread.';

/** The two parts of a feed reference that address the generator record. */
export interface FeedRef {
  /** Handle or DID that owns the generator record. */
  authority: string;
  /** Record key of the generator. */
  rkey: string;
}

/** Split a feed AT-URI or bsky.app feed URL into authority and record key; undefined for anything else. */
export function parseFeedRef(ref: string): FeedRef | undefined {
  const m = FEED_REF_REGEX.exec(ref);
  const authority = m?.[1] ?? m?.[3];
  const rkey = m?.[2] ?? m?.[4];
  return authority && rkey ? { authority, rkey } : undefined;
}

/** The generator record's AT-URI for a feed reference. */
export function feedGeneratorUri({ authority, rkey }: FeedRef): string {
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
 * BCP-47 language tag *shape* — a 2–3 letter primary subtag followed by any number of
 * alphanumeric subtags, so "en", "ja", "en-US", "pt-BR", and "zh-Hant" all pass.
 *
 * Deliberately a shape check and not a language-code registry: the AppView validates
 * shape only. "qqq" is shape-valid but names no language, and Bluesky answers it with
 * 200 and the filter quietly dropped rather than an error; a registry check here would
 * be stricter than the API it wraps and could reject a tag Bluesky would have honoured.
 * Shape validation catches the loud failure — "english", "zzzz", and "e n" all come
 * back as a bare upstream 400.
 */
export const BCP47_LANGUAGE_REGEX = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{1,8})*$/;

/** Validation message paired with {@link BCP47_LANGUAGE_REGEX}. */
export const BCP47_LANGUAGE_MESSAGE =
  'Must be a BCP-47 language tag: a two- or three-letter language code, optionally followed by hyphen-separated subtags — "en", "ja", "es", "en-US", "pt-BR", "zh-Hant". A language name such as "english" is not a tag.';

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
  'Must be a full AT-URI of the form at://<handle-or-did>/<collection>/<rkey>, e.g. "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3lc4gpsxr3c2q". Copy it from the "uri" field of a post returned by bsky_search_posts or bsky_get_author_feed.';

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

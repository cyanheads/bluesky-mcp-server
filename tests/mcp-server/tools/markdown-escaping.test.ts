/**
 * @fileoverview Bluesky-authored text stays data under a CommonMark renderer. Every case is parsed
 * with the CommonMark reference implementation (`commonmark`), and passes only when the user text
 * produced no node beyond the paragraph, quote, text, and line-break nodes its framing implies, and
 * when the text a renderer shows equals the text the user wrote. The tool-level cases drive raw
 * AppView-shaped responses through the real service and normalizers over a faked `fetch`, so a
 * quoted post inside a post and a thread reply two levels down are rendered by the production path.
 * @module tests/mcp-server/tools/markdown-escaping.test
 */

import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyGetAuthorFeed } from '@/mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetPostThread } from '@/mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { inlineUserText, quoteUserText } from '@/mcp-server/tools/post-format.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';

// ---------------------------------------------------------------------------
// CommonMark inspection
// ---------------------------------------------------------------------------

const parser = new Parser();

/** Nodes a framed value may produce: the quote, its paragraphs, and their text. */
const LITERAL = new Set(['document', 'paragraph', 'block_quote', 'text', 'softbreak', 'linebreak']);

interface Parsed {
  /** The text a renderer would show, whitespace-normalized. */
  text: string;
  /** Every node type the document produced, entering order, repeats kept. */
  types: string[];
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

function parse(markdown: string): Parsed {
  const walker = parser.parse(markdown).walker();
  const types: string[] = [];
  let text = '';
  for (let event = walker.next(); event; event = walker.next()) {
    const { node, entering } = event;
    if (!entering) continue;
    types.push(node.type);
    if (node.type === 'text' || node.type === 'code') text += node.literal ?? '';
    if (node.type === 'softbreak' || node.type === 'linebreak') text += ' ';
    if (node.type === 'paragraph' || node.type === 'heading') text += ' ';
  }
  return { types, text: normalize(text) };
}

/** What a reader should see: the source, less the quote markers a leading `>` nests into. */
const shownText = (source: string) =>
  normalize(source.replace(/^(?: {0,3}>[ \t]?)+/gm, '').replace(/\r?\n/g, ' '));

// ---------------------------------------------------------------------------
// Hostile corpora
// ---------------------------------------------------------------------------

/** Multi-line user text, as a post body, bio, alt text, or link-card field carries it. */
const FRAMED_HOSTILE = [
  '**### heading**\n<script>alert(1)</script>',
  '# Heading\n## Sub',
  'Title\n===',
  'Title\n=== ',
  'Title\n---',
  '***\n___',
  '- bullet\n+ plus\n* star',
  '- - -\n-- -',
  '+\n-',
  '1. one\n2) two',
  '   # indented heading\n   1. indented list\n  - indented bullet',
  '```\ncode\n```',
  '~~~\ncode\n~~~',
  '`inline code`',
  '*em* _em_ **strong** __strong__ ~~strike~~',
  'snake_case_name and 2*3*4',
  '[click](https://evil.example) ![img](https://evil.example/p.png)',
  '[ref]: https://evil.example\n[ref]',
  '[a]: /u "t"',
  '<https://evil.example> <mail@evil.example>',
  '<img src=x onerror=alert(1)>',
  'visible <!-- hidden --> tail',
  '<?php echo 1; ?> <!DOCTYPE html> <![CDATA[x]]>',
  '<div>\n# inside html block\n</div>',
  'AT&T &copy; &#169; &#xA9; &lt;b&gt;',
  'back\\slash \\*not em\\* a\\\\b',
  'line with two trailing spaces  \nnext',
  'hard break\\\nnext',
  '> # quoted heading\n> - quoted list\n>> **deeper**',
  'https://bsky.app/profile/a_b.bsky.social/post/x~y',
  'https://a.example/?_x=1 then https://b.example/y_',
  'https://x.example/[a](javascript:alert(1))',
  'https://x.example/*a* and https://y.example/~b~',
  'emoji 🎉 **bold** end',
  'crlf **one**\r\n# two',
  '<1user@evil.example> <+tag@evil.example> <.x@evil.example> <_u@evil.example>',
  '\t# tab-indented heading\n\t- tab bullet\n \t1. space-tab list\n\t===',
];

/** Values that render inside a line the server writes. */
const INLINE_HOSTILE = [
  '**Admin** <img src=x onerror=alert(1)> [x](http://e)',
  '`code` <b>bold</b>',
  '# not a heading mid-line',
  'AT&T &copy;',
  'Team #',
  '###',
  '_under_ and *star* and ~~strike~~',
  'trailing backslash \\',
  'Alice\n### @admin',
  'https://x.example/*a* https://y.example/*b*',
  '<https://evil.example>',
  '![img](https://e.example/p.png)',
  'see https://x.example/a* then',
  '<9lives@evil.example>',
];

/** The four shapes of line an inline value lands in, each rendered by a formatter here. */
const INLINE_CONTEXTS: Array<[string, (value: string) => string]> = [
  ['a post author heading', (v) => `### ↳2 ${v} (@alice.bsky.social)`],
  ['a profile heading, where the value ends the line', (v) => `## ${v}`],
  ['a trend name inside strong emphasis', (v) => `1. **${v}**`],
  ['a label list', (v) => `**Labels:** ${v} src:did:plc:labeler`],
];

// ---------------------------------------------------------------------------

describe('quoteUserText under CommonMark', () => {
  it.each(FRAMED_HOSTILE)('renders %j as quoted text and nothing else', (source) => {
    const parsed = parse(quoteUserText(source).join('\n'));
    expect(parsed.types.filter((t) => !LITERAL.has(t))).toEqual([]);
    expect(parsed.text).toBe(shownText(source));
  });

  it('escapes the example from the issue as written there', () => {
    expect(quoteUserText('**### heading**\n<script>alert(1)</script>')).toEqual([
      '> \\*\\*### heading\\*\\*',
      '> &lt;script>alert(1)&lt;/script>',
    ]);
  });

  it('escapes an entity before it could decode, without re-escaping its own &lt;', () => {
    expect(quoteUserText('&lt;b&gt; <b>')).toEqual(['> &amp;lt;b&amp;gt; &lt;b>']);
  });

  it('still nests a line that opens with >, and escapes the block syntax behind it', () => {
    expect(quoteUserText('> # not a heading')).toEqual(['> > \\# not a heading']);
    const parsed = parse(quoteUserText('> # not a heading').join('\n'));
    expect(parsed.types.filter((t) => t === 'block_quote')).toHaveLength(2);
    expect(parsed.types).not.toContain('heading');
  });

  it('leaves a URL a caller copies out of the quote byte-identical', () => {
    const url = 'https://example.com/a_b/c?_t=x&_r=1#frag~1';
    expect(quoteUserText(`see ${url} now`)).toEqual([`> see ${url} now`]);
  });

  it('escapes a URL character that would otherwise pair into emphasis or a link', () => {
    expect(quoteUserText('https://x.example/[a](javascript:alert(1))')).toEqual([
      '> https://x.example/[a\\](javascript:alert(1))',
    ]);
    expect(quoteUserText('https://x.example/*a*')).toEqual(['> https://x.example/\\*a\\*']);
  });

  it('escapes the block syntax behind a tab the way it does behind spaces', () => {
    expect(quoteUserText('\t# x')).toEqual(['> \t\\# x']);
    expect(quoteUserText('\t> - x')).toEqual(['> \t> \\- x']);
    const nested = parse(quoteUserText('\t> # x').join('\n'));
    expect(nested.types.filter((t) => t === 'block_quote')).toHaveLength(2);
    expect(nested.types).not.toContain('heading');
  });

  it('leaves a line indented four characters or more, which renders as literal code, unescaped', () => {
    expect(quoteUserText('    # x')).toEqual(['>     # x']);
    expect(quoteUserText('\t \t # x')).toEqual(['> \t \t # x']);
  });

  it('escapes a marker behind up to three tabs, however wide the column makes them', () => {
    expect(quoteUserText('\t\t# x')).toEqual(['> \t\t\\# x']);
    expect(quoteUserText('  \t- x')).toEqual(['>   \t\\- x']);
  });

  it('keeps the blank-line, CRLF, and empty-text behavior', () => {
    expect(quoteUserText('**a**\r\n\r\n# b')).toEqual(['> \\*\\*a\\*\\*', '>', '> \\# b']);
    expect(quoteUserText('')).toEqual([]);
  });
});

describe('inlineUserText under CommonMark', () => {
  describe.each(INLINE_CONTEXTS)('in %s', (_label, render) => {
    /** The nodes the server's own markdown produces around a harmless value. */
    const skeleton = parse(render('X')).types.filter((t) => t !== 'text');

    it.each(INLINE_HOSTILE)('adds no node of its own for %j', (value) => {
      const parsed = parse(render(inlineUserText(value)));
      expect(parsed.types.filter((t) => t !== 'text')).toEqual(skeleton);
      expect(parsed.text).toBe(normalize(parse(render('X')).text.replace('X', value)));
    });
  });

  it('still folds line breaks before escaping', () => {
    expect(inlineUserText('Alice\r\n\n**Admin**')).toBe('Alice \\*\\*Admin\\*\\*');
    expect(inlineUserText('\n\n')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Through the production path — raw AppView responses, real normalizers, both channels
// ---------------------------------------------------------------------------

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

const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((b) => b.text ?? '').join('\n');

const POST_BODY = 'Top **bold**\n\n### Not a heading\n<img src=x onerror=alert(1)>';
const QUOTED_BODY = '[click](https://evil.example)\n---\n1. listed';
const DEEP_QUOTED_BODY = '`code` ~~~\n# deepest heading';
const DEEP_ALT = '![alt](https://evil.example/i.png)\n* bullet';
const HOSTILE_NAME = '**Admin** <b>x</b>';

const rawAuthor = (did: string, handle: string, displayName?: string) => ({
  did,
  handle,
  ...(displayName ? { displayName } : {}),
});

/** A post quoting a post that itself quotes a post carrying an image — three levels of text. */
const RAW_NESTED_QUOTE_POST = {
  uri: 'at://did:plc:alice/app.bsky.feed.post/p1',
  cid: 'bafyp1',
  author: rawAuthor('did:plc:alice', 'alice.bsky.social', HOSTILE_NAME),
  record: { text: POST_BODY },
  embed: {
    $type: 'app.bsky.embed.record#view',
    record: {
      $type: 'app.bsky.embed.record#viewRecord',
      uri: 'at://did:plc:bob/app.bsky.feed.post/q1',
      cid: 'bafyq1',
      author: rawAuthor('did:plc:bob', 'bob.bsky.social'),
      value: { text: QUOTED_BODY },
      embeds: [
        {
          $type: 'app.bsky.embed.record#view',
          record: {
            $type: 'app.bsky.embed.record#viewRecord',
            uri: 'at://did:plc:carol/app.bsky.feed.post/q2',
            cid: 'bafyq2',
            author: rawAuthor('did:plc:carol', 'carol.bsky.social'),
            value: { text: DEEP_QUOTED_BODY },
          },
        },
        {
          $type: 'app.bsky.embed.images#view',
          images: [{ fullsize: 'https://cdn.example/i.jpg', alt: DEEP_ALT }],
        },
      ],
    },
  },
};

/**
 * Every quoted block in the response parses to text alone. Each run of `>` lines is parsed on its
 * own, so the check covers what is inside a quote and nothing else; that each quote ends before the
 * server line after it is `quote-boundaries.test.ts`'s to prove.
 */
function expectQuotesHoldAsData(markdown: string) {
  const blocks = markdown.split('\n').reduce<string[][]>((acc, line, i, all) => {
    if (!/^ {0,3}>/.test(line)) return acc;
    if (i === 0 || !/^ {0,3}>/.test(all[i - 1] ?? '')) acc.push([]);
    acc.at(-1)?.push(line);
    return acc;
  }, []);
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    expect(parse(block.join('\n')).types.filter((t) => !LITERAL.has(t))).toEqual([]);
  }
}

describe('escaping through bsky_get_author_feed, a quoted post inside a post', () => {
  it('renders every level of quoted text as data and keeps structuredContent raw', async () => {
    http.route({
      match: /app\.bsky\.feed\.getAuthorFeed/,
      respond: Response.json({ feed: [{ post: RAW_NESTED_QUOTE_POST }] }),
    });

    const result = await runToolContract(bskyGetAuthorFeed, { actor: 'alice.bsky.social' });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);

    expectQuotesHoldAsData(text);
    expect(text).toContain('> Top \\*\\*bold\\*\\*');
    expect(text).toContain('   > \\[click\\](https://evil.example)');
    expect(text).toContain('   > \\`code\\` \\~\\~\\~');
    expect(text).toContain('   > \\# deepest heading');
    expect(text).toContain('   > !\\[alt\\](https://evil.example/i.png)');
    expect(text).toContain('### \\*\\*Admin\\*\\* &lt;b>x&lt;/b> (@alice.bsky.social)');

    /** The only headings are the server's own: its author heading. */
    const headings = parse(text).types.filter((t) => t === 'heading');
    expect(headings).toHaveLength(1);

    const post = (result.structuredContent as { posts: Array<Record<string, any>> }).posts[0];
    expect(post?.text).toBe(POST_BODY);
    expect(post?.author.displayName).toBe(HOSTILE_NAME);
    expect(post?.embed.text).toBe(QUOTED_BODY);
    expect(post?.embed.embeds[0].text).toBe(DEEP_QUOTED_BODY);
    expect(post?.embed.embeds[1].images[0].alt).toBe(DEEP_ALT);
  });
});

describe('escaping through bsky_get_post_thread, a reply two levels down', () => {
  const threadPost = (rkey: string, text: string, parent?: string, displayName?: string) => ({
    $type: 'app.bsky.feed.defs#threadViewPost',
    post: {
      uri: `at://did:plc:alice/app.bsky.feed.post/${rkey}`,
      cid: `bafy${rkey}`,
      author: rawAuthor('did:plc:alice', 'alice.bsky.social', displayName),
      record: {
        text,
        ...(parent
          ? {
              reply: {
                parent: { uri: `at://did:plc:alice/app.bsky.feed.post/${parent}` },
                root: { uri: 'at://did:plc:alice/app.bsky.feed.post/root' },
              },
            }
          : {}),
      },
      replyCount: 1,
    },
  });

  it('escapes the deepest reply the same way as the root, in content[] only', async () => {
    const deep = { ...threadPost('r2', POST_BODY, 'r1', HOSTILE_NAME), replies: [] };
    deep.post.replyCount = 0;
    const thread = {
      ...threadPost('root', 'root text'),
      replies: [{ ...threadPost('r1', 'first reply', 'root'), replies: [deep] }],
    };
    http.route({
      match: /app\.bsky\.feed\.getPostThread/,
      respond: Response.json({ thread }),
    });

    const result = await runToolContract(bskyGetPostThread, {
      uri: 'at://did:plc:alice/app.bsky.feed.post/root',
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);

    expectQuotesHoldAsData(text);
    expect(text).toContain('### ↳1 \\*\\*Admin\\*\\* &lt;b>x&lt;/b> (@alice.bsky.social)');
    expect(text).toContain('> \\### Not a heading');
    expect(text).toContain('> &lt;img src=x onerror=alert(1)>');

    const sc = result.structuredContent as { thread: Record<string, any> };
    const node = sc.thread.replies[0].replies[0];
    expect(node.post.text).toBe(POST_BODY);
    expect(node.post.author.displayName).toBe(HOSTILE_NAME);
  });
});

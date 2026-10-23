/**
 * @fileoverview Ordered detailed-profile links through the actual service, tool, and resource.
 * @module tests/mcp-server/tools/profile-links
 */
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bskyProfileResource } from '@/mcp-server/resources/definitions/bsky-profile.resource.js';
import { bskyGetProfile } from '@/mcp-server/tools/definitions/bsky-get-profile.tool.js';
import { bskySearchActors } from '@/mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { initBlueskyService } from '@/services/bluesky/bluesky-service.js';
import { textOf } from './budget-fixtures.js';

const http = createFetchMock([], {
  onUnhandled: () => Promise.reject(new Error('unmocked fetch')),
});
const profile = {
  did: 'did:plc:test',
  handle: 'test.bsky.social',
  pronouns: 'they/he',
  website: 'https://old.example.com',
  verification: { verifiedStatus: 'valid', trustedVerifierStatus: 'none', verifications: [] },
};
const links = [
  {
    uri: 'at://did:plc:test/app.bsky.actor.link/first',
    cid: 'first-cid',
    url: 'https://squidfacts.net/',
    title: 'Science Merch!',
    icon: 'https://cdn.example.com/first.png',
    labels: [],
  },
  {
    uri: 'at://did:plc:test/app.bsky.actor.link/second',
    cid: 'second-cid',
    url: 'https://givebutter.com/SupportSAS26',
    title: '# Title\n\n[escape](https://evil.example)',
    labels: [{ val: 'test', src: 'did:plc:labeler', cts: '2026-10-22T00:00:00Z' }],
  },
  {
    uri: 'at://did:plc:test/app.bsky.actor.link/third',
    cid: 'third-cid',
    url: 'https://www.skypeascientist.com/a_(b)?q=[c]&x=1',
    title: '',
    icon: '',
    labels: [],
  },
  {
    uri: 'at://did:plc:test/app.bsky.actor.link/fourth',
    cid: 'fourth-cid',
    url: 'https://example.com/no-title',
  },
];

beforeEach(() => {
  http.reset();
  http.install();
  initBlueskyService();
});
afterEach(() => http.restore());
const route = (body: unknown) =>
  http.route({ match: /app\.bsky\.actor\.getProfile\?/, respond: () => Response.json(body) });

describe('profile characterization', () => {
  it('keeps website, pronouns and verification together on the existing detailed profile', async () => {
    route(profile);
    const result = await runToolContract(bskyGetProfile, { actor: profile.handle });
    expect(result.structuredContent).toMatchObject(profile);
    expect(textOf(result)).toContain('https://old.example.com');
    expect(textOf(result)).toContain('they/he');
    expect(textOf(result)).toContain('**Verified:** valid');
    expect(result.structuredContent).not.toHaveProperty('links');
  });
});

describe('ordered profile links', () => {
  it('retains the declared not-found reason and recovery through both error surfaces', async () => {
    http.route({
      match: /app\.bsky\.actor\.getProfile\?/,
      respond: () =>
        Response.json({ error: 'InvalidRequest', message: 'Profile not found' }, { status: 400 }),
    });
    const result = await runToolContract(bskyGetProfile, { actor: 'missing.bsky.social' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'actor_not_found' } },
    });
    expect(textOf(result)).toContain('Actor not found');
    await expect(
      bskyProfileResource.handler(
        { actor: 'missing.bsky.social' },
        createMockContext({ errors: bskyProfileResource.errors }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'actor_not_found' } });
  });

  it('rejects invalid actor input before requesting a profile', async () => {
    const result = await runToolContract(bskyGetProfile, { actor: '' });
    expect(result.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
  });
  it('preserves every field and upstream order on both tool channels and the resource', async () => {
    route({ ...profile, links });
    const result = await runToolContract(bskyGetProfile, { actor: profile.handle });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject(profile);
    expect(result.structuredContent).toHaveProperty('links', links);
    const resource = await bskyProfileResource.handler(
      bskyProfileResource.params!.parse({ actor: profile.handle }),
      createMockContext({ errors: bskyProfileResource.errors }),
    );
    expect(resource).toHaveProperty('links', links);
    const md = textOf(result);
    let previous = -1;
    for (const link of links) {
      expect(md.indexOf(link.uri)).toBeGreaterThan(previous);
      previous = md.indexOf(link.uri);
      expect(md).toContain(link.cid);
    }
    const walker = new Parser().parse(md).walker();
    const destinations: string[] = [];
    const images: string[] = [];
    const quoted: string[] = [];
    let depth = 0;
    for (let event = walker.next(); event; event = walker.next()) {
      if (event.node.type === 'block_quote') depth += event.entering ? 1 : -1;
      if (event.entering && event.node.type === 'link')
        destinations.push(decodeURI(event.node.destination ?? ''));
      if (event.entering && event.node.type === 'image')
        images.push(decodeURI(event.node.destination ?? ''));
      if (depth && event.entering && event.node.type === 'text')
        quoted.push(event.node.literal ?? '');
    }
    expect(destinations).toContain('https://www.skypeascientist.com/a_(b)?q=[c]&x=1');
    expect(destinations).not.toContain('https://evil.example');
    expect(images).toEqual(['https://cdn.example.com/first.png']);
    expect(quoted.join('')).toContain('# Title[escape](https://evil.example)');
    expect(md).toContain('src:did:plc:labeler');
    expect(md).toContain('cts:2026-10-22T00:00:00Z');
    expect(md).toContain('**Labels:** 0');
    expect(md).toContain('**Title:** (empty)');
    expect(md).toContain('**Icon:** (empty)');
  });

  it.each([undefined, []])(
    'distinguishes omitted and explicitly empty links (%j)',
    async (value) => {
      route({ ...profile, ...(value === undefined ? {} : { links: value }) });
      const result = await runToolContract(bskyGetProfile, { actor: profile.handle });
      const resource = await bskyProfileResource.handler(
        { actor: profile.handle },
        createMockContext({ errors: bskyProfileResource.errors }),
      );
      if (value === undefined) {
        expect(result.structuredContent).not.toHaveProperty('links');
        expect(resource).not.toHaveProperty('links');
      } else {
        expect(result.structuredContent).toHaveProperty('links', []);
        expect(resource).toHaveProperty('links', []);
        expect(textOf(result)).toContain('**Profile links:** 0');
      }
    },
  );

  it('does not synthesize detailed links on actor summaries', async () => {
    http.route({
      match: /app\.bsky\.actor\.searchActors\?/,
      respond: () => Response.json({ actors: [{ ...profile, links }] }),
    });
    const result = await runToolContract(bskySearchActors, { query: 'test' });
    expect(JSON.stringify(result.structuredContent)).not.toContain('app.bsky.actor.link');
    expect(textOf(result)).not.toContain('squidfacts.net');
  });
});

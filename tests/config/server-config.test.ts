/**
 * @fileoverview Tests for the server config: the optional app-password pair that enables search.
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh module each time, since the parsed config is cached for the life of the process. */
async function load() {
  vi.resetModules();
  return (await import('@/config/server-config.js')).getServerConfig();
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getServerConfig', () => {
  it('enables search when both variables are set', async () => {
    vi.stubEnv('BLUESKY_IDENTIFIER', 'operator.bsky.social');
    vi.stubEnv('BLUESKY_APP_PASSWORD', 'abcd-efgh-ijkl-mnop');

    expect(await load()).toEqual({
      searchCredentials: { identifier: 'operator.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' },
    });
  });

  it('leaves search off when neither is set', async () => {
    vi.stubEnv('BLUESKY_IDENTIFIER', undefined);
    vi.stubEnv('BLUESKY_APP_PASSWORD', undefined);
    expect(await load()).toEqual({});
  });

  it.each([
    ['blank values, as an MCPB host forwards an option left empty', '', ''],
    [
      'unsubstituted placeholders',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text an MCPB host forwards when it substitutes nothing
      '${user_config.BLUESKY_IDENTIFIER}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text an MCPB host forwards when it substitutes nothing
      '${user_config.BLUESKY_APP_PASSWORD}',
    ],
  ])('reads %s as unset', async (_label, identifier, password) => {
    vi.stubEnv('BLUESKY_IDENTIFIER', identifier);
    vi.stubEnv('BLUESKY_APP_PASSWORD', password);
    expect(await load()).toEqual({});
  });

  it.each([
    ['only the identifier', 'operator.bsky.social', '', 'BLUESKY_APP_PASSWORD'],
    ['only the app password', '', 'abcd-efgh-ijkl-mnop', 'BLUESKY_IDENTIFIER'],
  ])(
    'fails naming the missing variable when %s is set',
    async (_label, identifier, password, missing) => {
      vi.stubEnv('BLUESKY_IDENTIFIER', identifier);
      vi.stubEnv('BLUESKY_APP_PASSWORD', password);

      const err = await load().catch((e: unknown) => e);
      expect(err).toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
      const message = (err as Error).message;
      expect(message).toContain('BLUESKY_APP_PASSWORD');
      expect(message).toContain('BLUESKY_IDENTIFIER');
      // The issue line leads with the variable to add, not the one already set.
      expect(message).toMatch(new RegExp(`- ${missing} \\(`));
      expect(message).not.toContain('abcd-efgh-ijkl-mnop');
      expect(message).not.toContain('operator.bsky.social');
    },
  );
});

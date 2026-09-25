/**
 * @fileoverview The real entry point, `src/index.ts`, started as a stdio subprocess under each
 * credential configuration: what `tools/list` offers with and without the app-password pair, and
 * how a half-configured pair fails startup. The framework exposes no in-process way to build the
 * registered server short of `createApp()`, which owns the transport and the process signal
 * handlers, so the entry point runs as its own process — which is also what a client starts.
 * No request leaves the machine: startup and `tools/list` make none, since search logs in lazily.
 * @module tests/entrypoint.test
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

interface Run {
  code: number | null;
  replies: Array<{ id?: number; result?: unknown; error?: unknown }>;
  stderr: string;
}

/**
 * Start the entry point with the given pair (`undefined` leaves a variable unset), send the
 * messages, then close stdin — the stdio transport's shutdown signal — and collect what came back.
 */
function runEntry(
  pair: { identifier?: string; appPassword?: string },
  messages: object[],
): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // DEBUG would make the framework print the stack the banner test asserts is hidden.
    if (v !== undefined && !k.startsWith('BLUESKY_') && k !== 'DEBUG') env[k] = v;
  }
  Object.assign(env, { MCP_TRANSPORT_TYPE: 'stdio', MCP_LOG_LEVEL: 'error', NODE_ENV: 'test' });
  if (pair.identifier !== undefined) env.BLUESKY_IDENTIFIER = pair.identifier;
  if (pair.appPassword !== undefined) env.BLUESKY_APP_PASSWORD = pair.appPassword;

  return new Promise((resolve, reject) => {
    const child = spawn('bun', [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const expected = messages.filter((m) => 'id' in m).length;
    const replies: Run['replies'] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      let nl = stdout.indexOf('\n');
      while (nl >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (line.startsWith('{')) {
          const msg = JSON.parse(line) as Run['replies'][number];
          if (msg.id !== undefined) replies.push(msg);
        }
        nl = stdout.indexOf('\n');
      }
      if (replies.length >= expected) child.stdin.end();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, replies, stderr }));
    for (const m of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    if (expected === 0) child.stdin.end();
  });
}

const HANDSHAKE = [
  {
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'entrypoint-test', version: '1.0.0' },
    },
  },
  { method: 'notifications/initialized' },
];

/** Tool names from the `tools/list` reply; fails loudly when the server sent none. */
function toolNames(run: Run): string[] {
  const reply = run.replies.find((r) => r.id === 2);
  if (!reply?.result) throw new Error(`no tools/list result; stderr: ${run.stderr.slice(0, 500)}`);
  return (reply.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
}

describe('the entry point — tools/list follows the credential pair', () => {
  it('omits bsky_search_posts, and refuses a call to it, without credentials', async () => {
    const run = await runEntry({}, [
      ...HANDSHAKE,
      { id: 2, method: 'tools/list' },
      {
        id: 3,
        method: 'tools/call',
        params: { name: 'bsky_search_posts', arguments: { query: 'x' } },
      },
    ]);

    const names = toolNames(run);
    expect(names).not.toContain('bsky_search_posts');
    expect(names).toEqual(expect.arrayContaining(['bsky_get_feed', 'bsky_get_trending']));
    expect(names).toHaveLength(7);
    const call = run.replies.find((r) => r.id === 3);
    expect(JSON.stringify(call)).toMatch(/bsky_search_posts not found/);
    expect(run.code).toBe(0);
  }, 30_000);

  it('includes bsky_search_posts with both variables set, without logging in at startup', async () => {
    const run = await runEntry({ identifier: 'operator.bsky.social', appPassword: 'abcd-efgh' }, [
      ...HANDSHAKE,
      { id: 2, method: 'tools/list' },
    ]);

    const names = toolNames(run);
    expect(names).toEqual(expect.arrayContaining(['bsky_search_posts', 'bsky_get_feed']));
    expect(names).toHaveLength(8);
    expect(run.stderr).not.toContain('abcd-efgh');
    expect(run.code).toBe(0);
  }, 30_000);
});

describe('the entry point — a half-configured pair', () => {
  it.each([
    ['only the app password', { appPassword: 'abcd-efgh' }, 'BLUESKY_IDENTIFIER'],
    ['only the identifier', { identifier: 'operator.bsky.social' }, 'BLUESKY_APP_PASSWORD'],
  ])(
    'with %s fails startup through the framework banner, naming the missing variable',
    async (_label, pair, missing) => {
      const run = await runEntry(pair, []);

      expect(run.code).toBe(1);
      expect(run.stderr).toContain('Configuration error — server failed to start');
      expect(run.stderr).toContain(`- ${missing} (`);
      // No stack trace or source frame — the framework hides both unless DEBUG is set.
      expect(run.stderr).not.toMatch(/^\s+at /m);
      expect(run.stderr).not.toMatch(/^\d+ \| /m);
      expect(run.stderr).not.toContain('abcd-efgh');
      expect(run.replies).toEqual([]);
    },
    30_000,
  );
});

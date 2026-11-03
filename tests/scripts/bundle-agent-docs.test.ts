/**
 * @fileoverview Protect runtime modules from MCPB agent-document pruning.
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';

const cleanerUrl = new URL('../../scripts/clean-mcpb.ts', import.meta.url);
const linterUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url);
const cleaner: { AGENT_DOC_ENTRY: RegExp } = await import(cleanerUrl.href);
const linter: { AGENT_DOC_ENTRY: RegExp } = await import(linterUrl.href);

describe.each([
  ['cleaner', cleaner.AGENT_DOC_ENTRY],
  ['linter', linter.AGENT_DOC_ENTRY],
] as const)('%s agent-document selection', (_name, pattern) => {
  it.each([
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/example/skills/guide/SKILL.md',
    'node_modules/example/.claude/settings.json',
    'node_modules/example/.agents/skills/guide/SKILL.md',
    'node_modules/example/SKILL.md',
    'node_modules/outer/node_modules/@scope/inner/skills/guide/SKILL.md',
  ])('removes package-root authoring content: %s', (entry) => {
    expect(pattern.test(entry)).toBe(true);
  });

  it.each([
    'skills/bluesky-guide/SKILL.md',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.js',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
    'node_modules/example/dist/skills/runtime.js',
  ])('preserves published skills and runtime modules: %s', (entry) => {
    expect(pattern.test(entry)).toBe(false);
  });
});

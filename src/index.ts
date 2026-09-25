#!/usr/bin/env node
/**
 * @fileoverview bluesky-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { bskyProfileResource } from './mcp-server/resources/definitions/bsky-profile.resource.js';
import { serverInstructions, serverTools } from './mcp-server/server-surface.js';
import { initBlueskyService } from './services/bluesky/bluesky-service.js';

/**
 * Read before `createApp()` because the tool list depends on it: post search is registered only
 * when an app password is configured. A half-configured pair is not reported here — a throw at
 * module level escapes the framework and prints a raw stack — so it builds the list with search
 * off and fails from `setup()` instead, where the framework reports a `ConfigurationError` as its
 * startup banner. A failed parse is not cached, so `setup()` repeats it and throws the same error.
 */
function searchConfigured(): boolean {
  try {
    return getServerConfig().searchCredentials !== undefined;
  } catch {
    return false;
  }
}

const searchEnabled = searchConfigured();

await createApp({
  name: 'bluesky-mcp-server',
  title: 'bluesky-mcp-server',
  /**
   * No tool calls `ctx.requestInput`, so no request needs a session to be answered. Declared in
   * source rather than left to the schema default: with `MCP_SESSION_MODE` unset or empty the
   * server resolves to `stateless` from here, and an explicit `MCP_SESSION_MODE` value still
   * overrides it.
   */
  sessionMode: 'stateless',
  tools: serverTools(searchEnabled),
  resources: [bskyProfileResource],
  prompts: [],
  instructions: serverInstructions(searchEnabled),
  setup(_core) {
    initBlueskyService(getServerConfig().searchCredentials);
  },
});

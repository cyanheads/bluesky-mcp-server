#!/usr/bin/env node
/**
 * @fileoverview bluesky-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { bskyProfileResource } from './mcp-server/resources/definitions/bsky-profile.resource.js';
import { bskyGetAuthorFeed } from './mcp-server/tools/definitions/bsky-get-author-feed.tool.js';
import { bskyGetFollows } from './mcp-server/tools/definitions/bsky-get-follows.tool.js';
import { bskyGetPostThread } from './mcp-server/tools/definitions/bsky-get-post-thread.tool.js';
import { bskyGetProfile } from './mcp-server/tools/definitions/bsky-get-profile.tool.js';
import { bskyGetTrending } from './mcp-server/tools/definitions/bsky-get-trending.tool.js';
import { bskySearchActors } from './mcp-server/tools/definitions/bsky-search-actors.tool.js';
import { bskySearchPosts } from './mcp-server/tools/definitions/bsky-search-posts.tool.js';
import { initBlueskyService } from './services/bluesky/bluesky-service.js';

await createApp({
  name: 'bluesky-mcp-server',
  title: 'bluesky-mcp-server',
  tools: [
    bskyGetProfile,
    bskySearchActors,
    bskyGetTrending,
    bskyGetAuthorFeed,
    bskySearchPosts,
    bskyGetPostThread,
    bskyGetFollows,
  ],
  resources: [bskyProfileResource],
  prompts: [],
  instructions:
    'Bluesky MCP Server — read-only access to the public AT Protocol AppView.\n' +
    'No authentication required. All tools call https://api.bsky.app without credentials.\n\n' +
    'Key identifier types:\n' +
    '- Handle: human-readable username, e.g. "alice.bsky.social"\n' +
    '- DID: permanent identity key, e.g. "did:plc:z72i7hdynmk6r22z27h6tvur"\n' +
    '- AT-URI: post address, e.g. "at://did:plc:.../app.bsky.feed.post/rkey"\n\n' +
    'Typical workflows:\n' +
    '1. bsky_search_posts — find recent posts on any topic\n' +
    '2. bsky_get_post_thread — read a full conversation (AT-URI from search results)\n' +
    '3. bsky_get_profile — resolve a handle or look up an account\n' +
    '4. bsky_get_trending — discover what Bluesky is talking about right now',
  setup(_core) {
    initBlueskyService();
  },
});

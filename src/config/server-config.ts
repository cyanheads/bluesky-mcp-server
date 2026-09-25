/**
 * @fileoverview Server-specific configuration: the optional Bluesky app password that enables post
 * search. Parsed lazily through the framework's env helper, so a blank value — what an MCPB or
 * plugin host forwards for an option left empty — reads as unset.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { config, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import type { SearchCredentials } from '@/services/bluesky/search-session.js';

const ServerConfigSchema = z
  .object({
    identifier: z
      .string()
      .optional()
      .describe('Handle, DID, or email of the Bluesky account post search runs as.'),
    appPassword: z
      .string()
      .optional()
      .describe('App password for that account (Settings → Privacy and security → App passwords).'),
  })
  .superRefine((c, issues) => {
    if (Boolean(c.identifier) === Boolean(c.appPassword)) return;
    issues.addIssue({
      code: 'custom',
      message:
        'Set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD together to enable post search, or leave both unset.',
      // Filed against the variable that is missing, so the startup error names the one to add.
      path: [c.identifier ? 'appPassword' : 'identifier'],
    });
  });

/** Parsed server configuration. */
export interface ServerConfig {
  /** Present only when both variables are set — the one switch for the search tool. */
  searchCredentials?: SearchCredentials;
}

let _config: ServerConfig | undefined;

/**
 * Server configuration, parsed on first call. Throws a `ConfigurationError` naming the variable
 * when only one of the pair is set: half a login cannot enable search, and silently disabling it
 * would hide the typo that caused it.
 */
export function getServerConfig(): ServerConfig {
  /**
   * Core config loads `.env` into `process.env` on its first read. Reading it here first lets the
   * pair live in that file too, instead of depending on which module happened to import it first.
   */
  void config.mcpServerName;
  _config ??= toServerConfig(
    parseEnvConfig(ServerConfigSchema, {
      identifier: 'BLUESKY_IDENTIFIER',
      appPassword: 'BLUESKY_APP_PASSWORD',
    }),
  );
  return _config;
}

function toServerConfig({
  identifier,
  appPassword,
}: z.infer<typeof ServerConfigSchema>): ServerConfig {
  return identifier && appPassword ? { searchCredentials: { identifier, appPassword } } : {};
}

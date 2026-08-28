/**
 * MCP servers across agent harnesses, for Settings → MCP.
 *
 * Each harness keeps its own config file (the merge and file writing live in
 * `src-tauri/src/mcp.rs`); this module mirrors the wire types and holds the
 * pure build/display helpers the settings page needs. The server name is the
 * only join key that exists across harnesses.
 */

import { tokenize } from "@/lib/ide";

export type McpHarness = "claude" | "codex" | "opencode" | "grok" | "kilo";

/** Canonical display order, matching the backend merge. */
export const MCP_HARNESS_ORDER: readonly McpHarness[] = [
  "claude",
  "codex",
  "opencode",
  "grok",
  "kilo",
];

export const MCP_HARNESS_LABEL: Record<McpHarness, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  kilo: "Kilo",
};

export interface McpStdioTransport {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHttpTransport {
  kind: "http";
  url: string;
  headers: Record<string, string>;
}

export type McpTransport = McpStdioTransport | McpHttpTransport;

export interface McpHarnessEntry {
  harness: McpHarness;
  enabled: boolean;
  configPath: string;
  transport: McpTransport;
}

export interface McpServerInfo {
  name: string;
  differs: boolean;
  harnesses: McpHarnessEntry[];
}

/** What `mcp_add` takes; the transport shape mirrors the Rust enum. */
export interface McpAddSpec {
  name: string;
  harnesses: McpHarness[];
  transport: McpTransport;
}

/** Same restriction as the backend, so bad names fail before the write. */
const MCP_NAME = /^[a-zA-Z0-9_-]+$/;
export const isValidMcpName = (name: string): boolean => MCP_NAME.test(name);

/** One-line summary of a definition: the command line, or the URL. */
export const transportSummary = (transport: McpTransport): string =>
  transport.kind === "stdio"
    ? [transport.command, ...transport.args].join(" ")
    : transport.url;

export const entryFor = (
  server: McpServerInfo,
  harness: McpHarness
): McpHarnessEntry | undefined =>
  server.harnesses.find((entry) => entry.harness === harness);

/** Name/value rows from the dialog → object, dropping empty names. */
const pairsToMap = (
  pairs: Array<{ name: string; value: string }>
): Record<string, string> =>
  Object.fromEntries(
    pairs
      .filter((pair) => pair.name.trim() !== "")
      .map((pair) => [pair.name.trim(), pair.value])
  );

/** Build the wire transport from dialog fields; null while incomplete. The
 *  command line is tokenized like ide.ts custom commands — quotes included,
 *  never a shell. */
export const buildMcpTransport = (input: {
  kind: "stdio" | "http";
  commandLine: string;
  url: string;
  env: Array<{ name: string; value: string }>;
  headers: Array<{ name: string; value: string }>;
}): McpTransport | null => {
  if (input.kind === "stdio") {
    const [command, ...args] = tokenize(input.commandLine);
    if (!command) return null;
    return { kind: "stdio", command, args, env: pairsToMap(input.env) };
  }
  const url = input.url.trim();
  return url ? { kind: "http", url, headers: pairsToMap(input.headers) } : null;
};

import type { SlashCommand } from "@/types";

/** Claude Code's built-in slash commands. The Rust scan only finds project /
 *  user / plugin command files, so these are listed by hand to complete the
 *  picker. Custom commands with the same name take precedence when merged. */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Clear conversation history and free up context", source: "built-in" },
  { name: "compact", description: "Summarize the conversation to reclaim context", source: "built-in" },
  { name: "cost", description: "Show token usage and cost for this session", source: "built-in" },
  { name: "help", description: "List available commands and usage", source: "built-in" },
  { name: "model", description: "Choose the model for this session", source: "built-in" },
  { name: "config", description: "Open the configuration panel", source: "built-in" },
  { name: "review", description: "Review a pull request", source: "built-in" },
  { name: "init", description: "Generate a CLAUDE.md for this project", source: "built-in" },
  { name: "memory", description: "Edit CLAUDE.md memory files", source: "built-in" },
  { name: "resume", description: "Resume a previous conversation", source: "built-in" },
  { name: "exit", description: "End the current session", source: "built-in" },
  { name: "doctor", description: "Check the health of the installation", source: "built-in" },
  { name: "status", description: "Show account and system status", source: "built-in" },
  { name: "terminal-setup", description: "Install Shift+Enter key binding for newlines", source: "built-in" },
  { name: "vim", description: "Toggle vim editing mode", source: "built-in" },
  { name: "agents", description: "Manage custom subagents", source: "built-in" },
  { name: "mcp", description: "Manage MCP server connections", source: "built-in" },
  { name: "permissions", description: "View and edit tool permissions", source: "built-in" },
  { name: "hooks", description: "Manage hook configuration", source: "built-in" },
  { name: "add-dir", description: "Add a working directory to the session", source: "built-in" },
  { name: "bug", description: "Report a bug to Anthropic", source: "built-in" },
  { name: "login", description: "Sign in to your Anthropic account", source: "built-in" },
  { name: "logout", description: "Sign out of your Anthropic account", source: "built-in" },
  { name: "pr-comments", description: "Fetch comments from a pull request", source: "built-in" },
  { name: "release-notes", description: "Show release notes", source: "built-in" },
];

/** Built-ins plus fetched commands, deduped by name — a custom command wins over
 *  a built-in with the same name. */
export const mergeCommands = (fetched: SlashCommand[]): SlashCommand[] => {
  const byName = new Map<string, SlashCommand>();
  for (const cmd of BUILTIN_COMMANDS) byName.set(cmd.name, cmd);
  for (const cmd of fetched) byName.set(cmd.name, cmd);
  return [...byName.values()];
};

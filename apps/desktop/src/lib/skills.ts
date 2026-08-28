/**
 * Agent skills across harnesses, for Settings → Skills.
 *
 * Unlike the MCP configs in `mcp.ts`, skill folders are shared surfaces:
 * `~/.claude/skills` and `~/.agents/skills` are read by several harnesses, so
 * one folder can legitimately serve four of them. Sources group by physical
 * folder with the readers attached — one removal affects every reader, which
 * the UI must say. Scanning and file writes live in `src-tauri/src/skills.rs`.
 */

import { isValidMcpName, MCP_HARNESS_ORDER, type McpHarness } from "@/lib/mcp";

export type SkillHarness = McpHarness;

export interface SkillSource {
  /** The skill folder, e.g. `~/.claude/skills/deploy`. */
  skillDir: string;
  /** Every harness that reads this folder. */
  harnesses: McpHarness[];
}

export interface SkillInfo {
  name: string;
  description: string;
  /** True when copies under different folders disagree on SKILL.md. */
  differs: boolean;
  sources: SkillSource[];
}

export interface SkillAddSpec {
  name: string;
  description: string;
  body: string;
  harnesses: McpHarness[];
}

/** Same charset as the backend — it becomes a folder name everywhere. */
export const isValidSkillName = isValidMcpName;

/** Every harness this skill is live in, canonical order, deduped. */
export const readersOf = (skill: SkillInfo): McpHarness[] => {
  const seen = new Set<McpHarness>();
  for (const source of skill.sources) {
    for (const harness of source.harnesses) seen.add(harness);
  }
  return MCP_HARNESS_ORDER.filter((harness) => seen.has(harness));
};

/** Harnesses with no copy of this skill — the "add to" targets. */
export const missingFrom = (skill: SkillInfo): McpHarness[] =>
  MCP_HARNESS_ORDER.filter((harness) => !readersOf(skill).includes(harness));

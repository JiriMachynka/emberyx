import { describe, expect, it } from "vitest";
import { missingFrom, readersOf, isValidSkillName, type SkillInfo } from "./skills";

const skill: SkillInfo = {
  name: "deploy",
  description: "Ship the app",
  differs: false,
  sources: [
    {
      // Claude's home copy is read by four harnesses.
      skillDir: "/home/u/.claude/skills/deploy",
      harnesses: ["claude", "opencode", "grok", "kilo"],
    },
    {
      // Codex's own copy, read only by Codex.
      skillDir: "/home/u/.codex/skills/deploy",
      harnesses: ["codex"],
    },
  ],
};

describe("readersOf", () => {
  it("dedupes readers across folders in canonical order", () => {
    expect(readersOf(skill)).toEqual(["claude", "codex", "opencode", "grok", "kilo"]);
  });
});

describe("missingFrom", () => {
  it("lists harnesses with no copy", () => {
    const partial: SkillInfo = {
      ...skill,
      sources: [skill.sources[1]],
    };
    expect(missingFrom(partial)).toEqual(["claude", "opencode", "grok", "kilo"]);
    expect(missingFrom(skill)).toEqual([]);
  });
});

describe("isValidSkillName", () => {
  it("rejects names that cannot be folders", () => {
    expect(isValidSkillName("deploy-staging")).toBe(true);
    expect(isValidSkillName("has space")).toBe(false);
  });
});

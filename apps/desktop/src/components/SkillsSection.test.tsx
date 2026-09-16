import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { SkillsSection } from "@/components/SkillsSection";
import type { SkillInfo } from "@/lib/skills";
import { flush, renderWithQuery } from "@/test-utils/render";

const calls: [string, Record<string, unknown>][] = [];
const listed: SkillInfo[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args ?? {}]);
    if (cmd === "provider_status") return Promise.resolve([]);
    if (cmd === "skills_list") return Promise.resolve(listed);
    return Promise.resolve(null);
  },
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  listed.length = 0;
});

const claudeHomeOnly: SkillInfo = {
  name: "deploy",
  description: "Ship the app",
  differs: false,
  sources: [
    {
      skillDir: "/home/u/.claude/skills/deploy",
      harnesses: ["claude", "opencode", "grok", "kilo"],
    },
  ],
};

const everywhere: SkillInfo = {
  ...claudeHomeOnly,
  sources: [
    claudeHomeOnly.sources[0],
    { skillDir: "/home/u/.codex/skills/deploy", harnesses: ["codex"] },
  ],
};

const mount = async () => {
  const view = renderWithQuery(<SkillsSection />);
  await flush();
  return view;
};

describe("SkillsSection", () => {
  it("copies a Claude-home skill to Codex, the only harness that does not read that folder", async () => {
    listed.push(claudeHomeOnly);
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Copy missing to every harness" }));
    await flush();
    expect(calls.filter(([cmd]) => cmd === "skills_copy")).toEqual([
      ["skills_copy", { skillDir: "/home/u/.claude/skills/deploy", harness: "codex" }],
    ]);
  });

  it("hides the copy-missing action when every skill is already live everywhere", async () => {
    listed.push(everywhere);
    await mount();
    expect(
      screen.queryByRole("button", { name: "Copy missing to every harness" })
    ).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { SettingsPage } from "@/components/SettingsPage";
import { TABS } from "@/components/settings/tabs";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/settings";
import { THEMES } from "@/lib/themes";
import type { ProviderStatus } from "@/lib/providers";
import { flush, openFromKeyboard, renderWithQuery } from "@/test-utils/render";

const asked: string[] = [];
let askAnswer = true;

const PROVIDERS: ProviderStatus[] = [
  { id: "claude", label: "Claude", binary: "claude", installed: true, version: "2.1.0" },
  { id: "codex", label: "Codex", binary: "codex", installed: false, version: null },
];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: (cmd: string) => {
    if (cmd === "provider_status") return Promise.resolve(PROVIDERS);
    if (cmd === "forge_cli_status") return Promise.resolve([]);
    if (cmd === "mcp_list" || cmd === "skills_list") return Promise.resolve([]);
    // The T3 import row hides itself unless a store exists.
    if (cmd === "t3_import_available") return Promise.resolve(false);
    return Promise.resolve(null);
  },
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("9.9.9"),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (message: string) => {
    asked.push(message);
    return Promise.resolve(askAnswer);
  },
  open: () => Promise.resolve(null),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => Promise.resolve(null) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => Promise.resolve() }));

/** Every conditional row switched on, so a sweep over the page reaches each
 *  control a section can render: the "all threads" rows, the custom IDE
 *  command, a Claude profile with an environment row. */
const FULL: Settings = {
  ...DEFAULT_SETTINGS,
  threadView: "all",
  ide: "custom",
  claudeProfiles: [
    { id: "p1", name: "Work", command: "", args: "", configDir: "", env: [{ name: "A", value: "1" }] },
  ],
};

const mount = async (settings: Settings = DEFAULT_SETTINGS) => {
  // The page portals its tab list into a host the Sidebar owns; stand one in.
  const host = document.createElement("div");
  host.id = "settings-navigation";
  document.body.appendChild(host);
  const patches: Partial<Settings>[] = [];
  const view = renderWithQuery(
    <SettingsPage
      active
      onBack={() => {}}
      settings={settings}
      onUpdate={(patch) => patches.push(patch)}
    />
  );
  await flush();
  return { ...view, host, patches };
};

const nav = (host: HTMLElement) => within(host);

const openTab = async (host: HTMLElement, label: string) => {
  fireEvent.click(nav(host).getByRole("button", { name: label }));
  await flush();
};

/** The column the active section renders into — below the page heading, so a
 *  sweep never reaches the header's Restore button or the tab list. */
const content = () => {
  const heading = screen.getByRole("heading", { level: 1 });
  const column = heading.parentElement;
  if (!column) throw new Error("no content column");
  return column;
};

/** A distinctive piece of each section, so a tab that renders the wrong
 *  section (or none) fails even though the heading above it is right. */
const LANDMARK: Record<string, string> = {
  general: "Thread list",
  appearance: "Chat font",
  shortcuts: "Reset all shortcuts",
  providers: "Default backend",
  mcp: "Servers",
  skills: "Skills",
  connections: "Keep agents running in the background",
  snapshots: "Capture the frontmost window",
  sourceControl: "Commit message model",
  notifications: "Notify on errors",
  about: "Check for updates",
};

/** Walk up from a row's label to the row that also holds its control. */
const controlFor = (label: string, selector: string): HTMLElement => {
  let el: HTMLElement | null = within(content()).getByText(label, { selector: "span" });
  while (el && !el.querySelector(selector)) el = el.parentElement;
  const control = el?.querySelector<HTMLElement>(selector);
  if (!control) throw new Error(`no ${selector} for ${label}`);
  return control;
};

/** Pick the first option of an open Radix select that isn't the current one. */
const pickOtherOption = async (trigger: HTMLElement) => {
  openFromKeyboard(trigger);
  await flush();
  const options = screen.queryAllByRole("option");
  const other = options.find((o) => o.getAttribute("aria-selected") !== "true");
  if (!other) throw new Error(`select "${trigger.textContent}" offered nothing to pick`);
  fireEvent.click(other);
  await flush();
};

/** Operate every control in the section once and report which settings keys
 *  the writes named. Values don't matter here — only who owns what. */
const sweep = async (patches: Partial<Settings>[]) => {
  const root = content();
  for (const input of Array.from(root.querySelectorAll("input"))) {
    const next = input.type === "number" ? String(Number(input.value) + 1) : `${input.value}x`;
    fireEvent.change(input, { target: { value: next } });
  }
  for (const button of Array.from(root.querySelectorAll("button"))) {
    if (!button.isConnected || button.disabled) continue;
    if (button.getAttribute("role") === "combobox") await pickOtherOption(button);
    else fireEvent.click(button);
  }
  await flush();
  return new Set(patches.flatMap((p) => Object.keys(p)));
};

beforeEach(() => {
  asked.length = 0;
  askAnswer = true;
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("SettingsPage", () => {
  it("lists every tab, and each one mounts its own section under its heading", async () => {
    const { host } = await mount(FULL);
    expect(nav(host).getAllByRole("button").map((b) => b.textContent)).toEqual(
      TABS.map((t) => t.label)
    );
    for (const tab of TABS) {
      await openTab(host, tab.label);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(tab.label);
      expect(within(content()).getAllByText(LANDMARK[tab.id]).length).toBeGreaterThan(0);
    }
  });

  it("finds a tab by the words it declares, not only by its label", async () => {
    const { host } = await mount();
    const search = nav(host).getByPlaceholderText("Search");
    const cases: [string, string][] = [
      ["whitespace", "Source Control"],
      ["daemon", "Connections"],
      ["scrollback", "Appearance"],
      ["sandbox", "Providers"],
      ["rebind", "Keyboard Shortcuts"],
      ["sound", "Notifications"],
      ["settle", "General"],
    ];
    for (const [query, label] of cases) {
      fireEvent.change(search, { target: { value: query } });
      expect(nav(host).getAllByRole("button").map((b) => b.textContent)).toEqual([label]);
    }
    fireEvent.change(search, { target: { value: "zzz-nothing" } });
    expect(nav(host).queryAllByRole("button")).toEqual([]);
    expect(host.textContent).toContain("Nothing matches");

    // A filtered result still opens its tab.
    fireEvent.change(search, { target: { value: "whitespace" } });
    await openTab(host, "Source Control");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Source Control");
  });

  it("Restore defaults resets exactly the open tab's keys, to their defaults", async () => {
    const { host, patches } = await mount(FULL);
    for (const tab of TABS) {
      await openTab(host, tab.label);
      const restore = screen.queryByRole("button", { name: "Restore defaults" });
      if (tab.keys.length === 0) {
        // Nothing to reset — the action would be a no-op that claims otherwise.
        expect(restore).toBeNull();
        continue;
      }
      patches.length = 0;
      fireEvent.click(restore!);
      await flush();
      expect(asked.pop()).toContain(tab.label);
      expect(patches).toHaveLength(1);
      const [patch] = patches;
      expect(Object.keys(patch).sort()).toEqual([...tab.keys].sort());
      for (const key of tab.keys) expect(patch[key]).toEqual(DEFAULT_SETTINGS[key]);
    }
  });

  it("Restore defaults writes nothing when the confirmation is declined", async () => {
    const { host, patches } = await mount(FULL);
    askAnswer = false;
    await openTab(host, "Notifications");
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }));
    await flush();
    expect(asked).toHaveLength(1);
    expect(patches).toEqual([]);
  });

  // The invariant in CLAUDE.md: a control rendered in a tab whose `keys` omit
  // its setting is a Restore that silently skips it. And the other way round —
  // a key no control on the tab writes is one Restore resets behind your back.
  it.each(TABS.filter((t) => t.keys.length > 0).map((t) => [t.label, t] as const))(
    "%s: its controls write exactly the keys the tab declares",
    async (label, tab) => {
      const { host, patches } = await mount(FULL);
      await openTab(host, label);
      const written = await sweep(patches);
      expect([...written].sort()).toEqual([...tab.keys].sort());
    }
  );

  describe("a representative control per section writes its own setting", () => {
    it("General: the settle-days stepper", async () => {
      const { host, patches } = await mount(FULL);
      await openTab(host, "General");
      fireEvent.change(controlFor("Days of inactivity before a thread settles", "input"), {
        target: { value: "9" },
      });
      expect(patches).toEqual([{ threadSettleDays: 9 }]);
    });

    it("General: the thread-list select", async () => {
      const { host, patches } = await mount();
      await openTab(host, "General");
      await pickOtherOption(controlFor("Thread list", "button[role=combobox]"));
      expect(patches).toEqual([{ threadView: "all" }]);
    });

    it("Appearance: a theme card", async () => {
      const { host, patches } = await mount();
      await openTab(host, "Appearance");
      const other = THEMES.find((t) => t.id !== DEFAULT_SETTINGS.theme)!;
      fireEvent.click(within(content()).getByText(other.label).closest("button")!);
      expect(patches).toEqual([{ theme: other.id }]);
    });

    it("Providers: the agent command", async () => {
      const { host, patches } = await mount();
      await openTab(host, "Providers");
      fireEvent.change(controlFor("Agent command", "input"), { target: { value: "codex" } });
      expect(patches).toEqual([{ agentCommand: "codex" }]);
    });

    it("Connections: the persistent-agents switch", async () => {
      const { host, patches } = await mount();
      await openTab(host, "Connections");
      fireEvent.click(
        screen.getByRole("switch", { name: /Keep agents running in the background/ })
      );
      expect(patches).toEqual([{ persistentAgents: true }]);
    });

    it("Source Control: the remote", async () => {
      const { host, patches } = await mount();
      await openTab(host, "Source Control");
      fireEvent.change(controlFor("Remote", "input"), { target: { value: "upstream" } });
      expect(patches).toEqual([{ gitlabRemote: "upstream" }]);
    });

    it("Notifications: the sound switch", async () => {
      const { host, patches } = await mount();
      await openTab(host, "Notifications");
      fireEvent.click(screen.getByRole("switch", { name: /Play sound/ }));
      expect(patches).toEqual([{ notifySound: true }]);
    });
  });
});

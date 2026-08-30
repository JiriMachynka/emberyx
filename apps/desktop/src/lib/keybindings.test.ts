import { beforeEach, describe, expect, it } from "vitest";
import {
  chordFromEvent,
  conflictingBindings,
  displayChord,
  formatChord,
  matchCommand,
  parseChord,
  resetAllBindings,
  resetBinding,
  resolveBindings,
  setBinding,
} from "@/lib/keybindings";

beforeEach(() => {
  localStorage.clear();
});

const press = (
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}
) => ({
  key,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("parseChord", () => {
  it("reads modifiers and key", () => {
    expect(parseChord("mod+shift+f")).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: "f",
    });
  });

  it("reads cmd as mod, and ctrl as Control itself", () => {
    expect(formatChord(parseChord("cmd+k")!)).toBe("mod+k");
    expect(formatChord(parseChord("ctrl+tab")!)).toBe("ctrl+tab");
  });

  it("rejects a bare modifier or an unknown one", () => {
    expect(parseChord("mod")).toBeNull();
    expect(parseChord("hyper+k")).toBeNull();
    expect(parseChord("")).toBeNull();
  });

  it("normalizes case, and names the space key as chordFromEvent does", () => {
    expect(parseChord("MOD+F")?.key).toBe("f");
    expect(parseChord("mod+space")?.key).toBe("space");
    expect(formatChord(chordFromEvent(press(" ", { meta: true }))!)).toBe("mod+space");
  });
});

describe("chordFromEvent", () => {
  it("records ⌘ as mod and a lone Control as ctrl", () => {
    expect(formatChord(chordFromEvent(press("k", { meta: true }))!)).toBe("mod+k");
    expect(formatChord(chordFromEvent(press("k", { ctrl: true }))!)).toBe("ctrl+k");
  });

  it("lowercases the shifted letter the browser reports", () => {
    const chord = chordFromEvent(press("F", { meta: true, shift: true }))!;
    expect(formatChord(chord)).toBe("mod+shift+f");
  });

  it("ignores a bare modifier press", () => {
    expect(chordFromEvent(press("Meta", { meta: true }))).toBeNull();
  });
});

describe("displayChord", () => {
  it("renders glyphs in platform order", () => {
    expect(displayChord("mod+shift+f")).toBe("⇧⌘F");
    expect(displayChord("mod+k")).toBe("⌘K");
    expect(displayChord("mod+alt+b")).toBe("⌥⌘B");
  });

  it("names keys that have no glyph", () => {
    expect(displayChord("mod+,")).toBe("⌘,");
  });

  it("hands back anything it can't parse, rather than an empty box", () => {
    expect(displayChord("nonsense")).toBe("nonsense");
  });
});

describe("bindings", () => {
  it("starts from the declared defaults", () => {
    expect(resolveBindings()["commandPalette.toggle"]).toBe("mod+k");
  });

  it("stores an override and gives it back canonically", () => {
    setBinding("commandPalette.toggle", "CMD+Shift+K");
    expect(resolveBindings()["commandPalette.toggle"]).toBe("mod+shift+k");
  });

  it("refuses an unparseable chord instead of storing a dead binding", () => {
    setBinding("commandPalette.toggle", "mod+");
    expect(resolveBindings()["commandPalette.toggle"]).toBe("mod+k");
  });

  it("ignores an override for a menu-owned command", () => {
    setBinding("tab.close", "mod+shift+w");
    expect(resolveBindings()["tab.close"]).toBe("mod+w");
  });

  it("resets one binding and all of them", () => {
    setBinding("commandPalette.toggle", "mod+j");
    setBinding("sidebar.toggle", "mod+alt+b");
    expect(resetBinding("commandPalette.toggle")["commandPalette.toggle"]).toBe("mod+k");
    expect(resolveBindings()["sidebar.toggle"]).toBe("mod+alt+b");
    expect(resetAllBindings()["sidebar.toggle"]).toBe("mod+b");
  });
});

describe("matchCommand", () => {
  it("fires the command bound to the pressed chord", () => {
    const b = resolveBindings();
    expect(matchCommand(press("k", { meta: true }), b)).toBe(
      "commandPalette.toggle"
    );
    expect(matchCommand(press("F", { meta: true, shift: true }), b)).toBe(
      "project.search"
    );
  });

  it("follows an override", () => {
    const b = setBinding("commandPalette.toggle", "mod+j");
    expect(matchCommand(press("j", { meta: true }), b)).toBe(
      "commandPalette.toggle"
    );
    expect(matchCommand(press("k", { meta: true }), b)).toBeNull();
  });

  it("never claims a menu-owned chord, which would run the action twice", () => {
    expect(matchCommand(press("w", { meta: true }), resolveBindings())).toBeNull();
  });

  it("ignores a plain keypress with no modifier", () => {
    expect(matchCommand(press("k"), resolveBindings())).toBeNull();
  });

  // `mod` has to stay portable — Ctrl+K is how the palette opens off macOS —
  // while `ctrl+tab` must mean Control, since ⌘Tab is the OS app switcher.
  it("accepts Ctrl for a mod chord but not ⌘ for a ctrl chord", () => {
    const b = resolveBindings();
    expect(matchCommand(press("k", { ctrl: true }), b)).toBe(
      "commandPalette.toggle"
    );
    expect(matchCommand(press("Tab", { ctrl: true }), b)).toBe("tab.next");
    expect(matchCommand(press("Tab", { meta: true }), b)).toBeNull();
  });

  it("separates the two tab-cycling directions by shift", () => {
    const b = resolveBindings();
    expect(matchCommand(press("Tab", { ctrl: true, shift: true }), b)).toBe(
      "tab.prev"
    );
  });
});

describe("conflictingBindings", () => {
  it("reports nothing for the defaults", () => {
    expect(conflictingBindings(resolveBindings()).size).toBe(0);
  });

  it("names both sides of a clash", () => {
    const b = setBinding("sidebar.toggle", "mod+k");
    const clash = conflictingBindings(b);
    expect(clash.has("sidebar.toggle")).toBe(true);
    expect(clash.has("commandPalette.toggle")).toBe(true);
  });
});

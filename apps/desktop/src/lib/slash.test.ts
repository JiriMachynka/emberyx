import { describe, expect, it } from "vitest";
import { applySlash, filterCommands, slashAt } from "@/lib/slash";

const cmd = (name: string, description = "") => ({ name, description });

describe("slashAt", () => {
  it("opens on a slash in the first column", () => {
    expect(slashAt("/rev", 4)).toEqual({ query: "rev" });
  });

  it("reports an empty query right after the slash", () => {
    expect(slashAt("/", 1)).toEqual({ query: "" });
  });

  it("ignores a slash anywhere but the start", () => {
    expect(slashAt("TODO: fix a/b", 13)).toBeNull();
    expect(slashAt(" /review", 8)).toBeNull();
  });

  it("closes once arguments start", () => {
    expect(slashAt("/review src/a.ts", 16)).toBeNull();
  });

  it("stays open while the caret is still inside the token", () => {
    expect(slashAt("/review src/a.ts", 7)).toEqual({ query: "review" });
  });

  it("returns null at caret 0", () => {
    expect(slashAt("/review", 0)).toBeNull();
  });
});

describe("applySlash", () => {
  it("replaces the typed token and leaves the caret ready for arguments", () => {
    expect(applySlash("/rev", "review", 4)).toEqual({
      text: "/review ",
      caret: 8,
    });
  });

  it("preserves text after the caret", () => {
    expect(applySlash("/rev trailing", "review", 4)).toEqual({
      text: "/review  trailing",
      caret: 8,
    });
  });
});

describe("filterCommands", () => {
  const commands = [
    cmd("review", "Review the diff"),
    cmd("commit", "Write a commit message"),
    cmd("caveman:review", "Terse review"),
    cmd("deploy", "Ship it and review nothing"),
  ];

  it("keeps the backend's order for an empty query", () => {
    expect(filterCommands(commands, "", 10).map((c) => c.name)).toEqual([
      "review",
      "commit",
      "caveman:review",
      "deploy",
    ]);
  });

  it("ranks prefix matches above substring matches", () => {
    const names = filterCommands(commands, "rev", 10).map((c) => c.name);
    expect(names[0]).toBe("review");
    expect(names).toContain("caveman:review");
  });

  it("falls back to matching the description", () => {
    expect(filterCommands(commands, "ship", 10).map((c) => c.name)).toEqual([
      "deploy",
    ]);
  });

  it("breaks score ties by shorter name", () => {
    const list = [cmd("committee", ""), cmd("commit", "")];
    expect(filterCommands(list, "commit", 10).map((c) => c.name)).toEqual([
      "commit",
      "committee",
    ]);
  });

  it("matches case-insensitively", () => {
    expect(filterCommands(commands, "REVIEW", 10)[0].name).toBe("review");
  });

  it("drops non-matches and respects the limit", () => {
    expect(filterCommands(commands, "zzz", 10)).toEqual([]);
    expect(filterCommands(commands, "e", 2)).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import { IDES, IDE_LABEL, buildIdeCommand, tokenize } from "@/lib/ide";

describe("IDES", () => {
  it("labels every editor, including the custom entry", () => {
    for (const ide of IDES) expect(IDE_LABEL[ide.id]).toBe(ide.label);
    expect(IDE_LABEL.custom).toBe("Custom");
  });

  it("gives every editor a way to open a project and a file", () => {
    for (const ide of IDES) {
      expect(ide.binary.length).toBeGreaterThan(0);
      expect(ide.projectArgs.join(" ")).toContain("{project}");
      expect(ide.fileArgs.join(" ")).toContain("{file}");
    }
  });
});

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("code -g file")).toEqual(["code", "-g", "file"]);
  });

  // A path with a space in it is one argument, not two.
  it("keeps a quoted run together", () => {
    expect(tokenize('mate "/My Projects/app" -l 3')).toEqual([
      "mate",
      "/My Projects/app",
      "-l",
      "3",
    ]);
    expect(tokenize("mate '/My Projects/app'")).toEqual(["mate", "/My Projects/app"]);
  });

  it("keeps an empty quoted argument rather than dropping it", () => {
    expect(tokenize('cmd "" x')).toEqual(["cmd", "", "x"]);
  });

  it("is empty for an empty command", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("buildIdeCommand", () => {
  it("opens a project when there is no file", () => {
    expect(buildIdeCommand("vscode", { project: "/repo" })).toEqual({
      program: "code",
      args: ["/repo"],
      cwd: "/repo",
    });
  });

  it("opens a file at a position", () => {
    expect(buildIdeCommand("vscode", { project: "/repo", file: "/repo/a.ts", line: 12, column: 4 })).toEqual({
      program: "code",
      args: ["/repo", "--goto", "/repo/a.ts:12:4"],
      cwd: "/repo",
    });
  });

  // Editors count from 1; a missing position means the top of the file, not
  // line zero, which several of these CLIs reject outright.
  it("defaults a missing position to the start of the file", () => {
    const command = buildIdeCommand("zed", { project: "/repo", file: "/repo/a.ts" });
    expect(command?.args).toEqual(["/repo", "/repo/a.ts:1:1"]);
  });

  it("uses the JetBrains flag form", () => {
    const command = buildIdeCommand("intellij", {
      project: "/repo",
      file: "/repo/a.ts",
      line: 9,
      column: 2,
    });
    expect(command?.args).toEqual(["--line", "9", "--column", "2", "/repo/a.ts"]);
  });

  it("expands every placeholder in a custom command", () => {
    const command = buildIdeCommand(
      "custom",
      { project: "/repo", file: "/repo/a.ts", line: 7, column: 3 },
      'mate "{project}" -l {line} -c {column} "{file}"'
    );
    expect(command).toEqual({
      program: "mate",
      args: ["/repo", "-l", "7", "-c", "3", "/repo/a.ts"],
      cwd: "/repo",
    });
  });

  // Better to report "no editor configured" than to try launching "".
  it("is null when a custom command is empty", () => {
    expect(buildIdeCommand("custom", { project: "/repo" }, "   ")).toBeNull();
    expect(buildIdeCommand("custom", { project: "/repo" })).toBeNull();
  });
});

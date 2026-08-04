import { describe, expect, it } from "vitest";
import { fileIconName } from "@/lib/fileIcon";

describe("fileIconName", () => {
  it("resolves by extension", () => {
    expect(fileIconName("a.ts")).toBe("typescript");
    expect(fileIconName("App.tsx")).toBe("react_ts");
    expect(fileIconName("src/main.rs")).toBe("rust");
    expect(fileIconName("a.astro")).toBe("astro");
  });

  it("prefers the longest compound extension", () => {
    // "foo.d.ts" must try "d.ts" before falling through to "ts".
    expect(fileIconName("foo.d.ts")).toBe("typescript-def");
    expect(fileIconName("foo.ts")).toBe("typescript");
  });

  it("lets an exact file name beat its extension", () => {
    expect(fileIconName("package.json")).toBe("nodejs");
    expect(fileIconName("a.json")).toBe("json");
    expect(fileIconName("pnpm-lock.yaml")).toBe("pnpm");
    expect(fileIconName("a.yaml")).toBe("yaml");
  });

  it("lets a directory suffix beat the file name", () => {
    expect(fileIconName(".config/babel-plugin-macrosrc.js")).toBe("babel");
    expect(fileIconName("repo/.config/babel-plugin-macrosrc.js")).toBe("babel");
    expect(fileIconName("babel-plugin-macrosrc.js")).toBe("javascript");
  });

  it("matches case-insensitively", () => {
    expect(fileIconName("README.MD")).toBe(fileIconName("readme.md"));
    expect(fileIconName("Dockerfile")).toBe("docker");
  });

  it("normalizes Windows separators", () => {
    expect(fileIconName(".config\\babel-plugin-macrosrc.js")).toBe("babel");
  });

  it("resolves names with no usable extension", () => {
    expect(fileIconName(".gitignore")).toBe("git");
    expect(fileIconName("LICENSE")).toBe("license");
  });

  it("falls back for unknown and empty names", () => {
    expect(fileIconName("unknown.zzz")).toBe("file");
    expect(fileIconName("")).toBe("file");
  });
});

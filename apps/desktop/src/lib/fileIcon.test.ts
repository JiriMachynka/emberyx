import { describe, expect, it } from "vitest";
import { fileIcon } from "@/lib/fileIcon";

describe("fileIcon", () => {
  it("gives the TypeScript family one shared accent", () => {
    const ts = fileIcon("App.tsx");
    for (const name of ["a.ts", "a.mts", "a.cts", "a.tsx"]) {
      expect(fileIcon(name)).toEqual(ts);
    }
  });

  it("distinguishes languages by color", () => {
    expect(fileIcon("a.ts").className).not.toBe(fileIcon("a.js").className);
    expect(fileIcon("a.rs").className).not.toBe(fileIcon("a.py").className);
  });

  it("matches the extension case-insensitively", () => {
    expect(fileIcon("README.MD")).toEqual(fileIcon("readme.md"));
  });

  it("resolves on the last segment of a multi-dot name", () => {
    expect(fileIcon("vite.config.ts")).toEqual(fileIcon("a.ts"));
  });

  it("treats every .env variant as an env file", () => {
    const env = fileIcon(".env");
    expect(fileIcon(".env.local")).toEqual(env);
    expect(fileIcon(".env.production")).toEqual(env);
  });

  it("lets whole-name matches beat the fallback", () => {
    // ".gitignore" has no usable extension, so only the by-name table saves it.
    expect(fileIcon(".gitignore")).not.toEqual(fileIcon("unknown.zzz"));
    expect(fileIcon("Dockerfile")).not.toEqual(fileIcon("LICENSE"));
  });

  it("falls back for an unknown extension and for no extension", () => {
    const fallback = fileIcon("unknown.zzz");
    expect(fileIcon("LICENSE")).toEqual(fallback);
    expect(fileIcon("")).toEqual(fallback);
  });
});

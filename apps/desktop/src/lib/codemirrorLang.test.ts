import { describe, expect, it } from "vitest";
import { languageFor } from "@/lib/codemirrorLang";

describe("languageFor", () => {
  it("loads a grammar for a known extension", async () => {
    expect(await languageFor("src/a.ts")).not.toBeNull();
  });

  it("caches by language, so two files of a kind share one instance", async () => {
    const [a, b] = await Promise.all([
      languageFor("src/a.ts"),
      languageFor("src/b.mts"),
    ]);
    expect(a).toBe(b);
  });

  it("keeps JSX and non-JSX variants apart", async () => {
    const [ts, tsx] = await Promise.all([
      languageFor("a.ts"),
      languageFor("a.tsx"),
    ]);
    expect(ts).not.toBe(tsx);
  });

  it("matches the extension case-insensitively", async () => {
    expect(await languageFor("README.MD")).toBe(await languageFor("readme.md"));
  });

  it("returns null for an unknown extension so the file still opens", async () => {
    expect(await languageFor("a.zzz")).toBeNull();
    expect(await languageFor("LICENSE")).toBeNull();
  });

  it("returns null when no file is open", async () => {
    expect(await languageFor(null)).toBeNull();
  });
});

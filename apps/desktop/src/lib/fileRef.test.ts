import { describe, expect, it } from "vitest";
import {
  absolutePath,
  isFileReference,
  pasteInsertion,
  pasteLanguage,
  relativeToProject,
  resolveFileRef,
  splitFileRefs,
} from "@/lib/fileRef";

describe("isFileReference", () => {
  it("accepts known extensions, known names and paths", () => {
    expect(isFileReference("ChatPane.tsx")).toBe(true);
    expect(isFileReference("src/lib/fileIcon.ts")).toBe(true);
    expect(isFileReference("apps/desktop/src-tauri/src/ingest.rs")).toBe(true);
    expect(isFileReference("Dockerfile")).toBe(true);
    expect(isFileReference("package.json")).toBe(true);
    expect(isFileReference("./scripts/build.sh")).toBe(true);
    expect(isFileReference("foo.d.ts")).toBe(true);
  });

  it("rejects the dotted things that aren't files", () => {
    // The whole reason the extension has to be known.
    expect(isFileReference("React.useState")).toBe(false);
    expect(isFileReference("array.map")).toBe(false);
    expect(isFileReference("example.com")).toBe(false);
    expect(isFileReference("1.2.3")).toBe(false);
    expect(isFileReference("https://example.com/a.ts")).toBe(false);
    expect(isFileReference("www.site.dev")).toBe(false);
  });

  it("rejects anything that isn't a single token", () => {
    expect(isFileReference("")).toBe(false);
    expect(isFileReference("src/a.ts and b.ts")).toBe(false);
    expect(isFileReference(`${"a".repeat(200)}.ts`)).toBe(false);
  });

  it("takes an unknown extension once it sits inside a path", () => {
    expect(isFileReference("src/data/thing.wat")).toBe(true);
    expect(isFileReference("thing.wat")).toBe(false);
  });
});

describe("splitFileRefs", () => {
  it("pulls mentions out of prose and keeps the spacing", () => {
    const segments = splitFileRefs("look at @src/lib/fileRef.ts please");
    expect(segments).toEqual([
      { kind: "text", text: "look at " },
      { kind: "file", text: "@src/lib/fileRef.ts", path: "src/lib/fileRef.ts" },
      { kind: "text", text: " please" },
    ]);
  });

  it("keeps sentence punctuation as prose", () => {
    const segments = splitFileRefs("see ChatPane.tsx, then Sidebar.tsx.");
    expect(segments.filter((s) => s.kind === "file").map((s) => s.path)).toEqual([
      "ChatPane.tsx",
      "Sidebar.tsx",
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(
      "see ChatPane.tsx, then Sidebar.tsx."
    );
  });

  it("leaves plain prose in one piece", () => {
    expect(splitFileRefs("no files here at all")).toEqual([
      { kind: "text", text: "no files here at all" },
    ]);
  });
});

describe("pasteLanguage", () => {
  it("recognises the languages this app deals in", () => {
    expect(pasteLanguage('{"a": 1}')).toBe("json");
    expect(pasteLanguage("diff --git a/x b/x\n@@ -1 +1 @@")).toBe("diff");
    expect(pasteLanguage("pub fn main() {\n  let mut x = 1;\n}")).toBe("rust");
    expect(pasteLanguage("def run(self):\n    return 1")).toBe("python");
    expect(pasteLanguage("interface Foo {\n  a: string;\n}")).toBe("typescript");
    expect(pasteLanguage("const A = () => <div />;\n")).toBe("tsx");
    expect(pasteLanguage("bun run test\ncargo clippy")).toBe("shell");
  });

  it("returns null for prose, so a paragraph never gets fenced", () => {
    expect(pasteLanguage("Please take a look at the chat pane and tell me")).toBe(
      null
    );
    expect(pasteLanguage("")).toBe(null);
  });

  it("falls through to the signal table when JSON-looking text isn't JSON", () => {
    expect(pasteLanguage("[dependencies]\nserde = 1")).toBe("toml");
  });
});

describe("resolveFileRef", () => {
  const files = [
    "src/lib/providers.ts",
    "src/lib/agentBackend.ts",
    "src/components/ChatPane.tsx",
    "src/components/ui/button.tsx",
    "docs/index.ts",
    "site/index.ts",
  ];

  it("takes an exact project path", () => {
    expect(resolveFileRef("src/lib/providers.ts", files)).toBe("src/lib/providers.ts");
  });

  it("resolves a bare filename the message wrote", () => {
    expect(resolveFileRef("providers.ts", files)).toBe("src/lib/providers.ts");
    expect(resolveFileRef("ChatPane.tsx", files)).toBe("src/components/ChatPane.tsx");
  });

  it("resolves a partial path by its suffix", () => {
    expect(resolveFileRef("ui/button.tsx", files)).toBe("src/components/ui/button.tsx");
    expect(resolveFileRef("./lib/agentBackend.ts", files)).toBe(
      "src/lib/agentBackend.ts"
    );
  });

  it("refuses to guess between two files with the same name", () => {
    expect(resolveFileRef("index.ts", files)).toBe(null);
  });

  it("returns null when the project has no such file", () => {
    expect(resolveFileRef("nowhere.ts", files)).toBe(null);
    expect(resolveFileRef("", files)).toBe(null);
  });
});

describe("absolutePath", () => {
  it("joins onto the project root exactly once", () => {
    expect(absolutePath("src/a.ts", "/home/p")).toBe("/home/p/src/a.ts");
    expect(absolutePath("src/a.ts", "/home/p/")).toBe("/home/p/src/a.ts");
  });
});

describe("relativeToProject", () => {
  it("strips the project root and leaves outside paths alone", () => {
    expect(relativeToProject("/home/p/src/a.ts", "/home/p")).toBe("src/a.ts");
    expect(relativeToProject("/home/p/src/a.ts", "/home/p/")).toBe("src/a.ts");
    expect(relativeToProject("/etc/hosts", "/home/p")).toBe("/etc/hosts");
  });
});

describe("pasteInsertion", () => {
  const base = { value: "", selectionStart: 0, selectionEnd: 0, cwd: "/home/p" };

  it("turns a pasted path into the mention the menu would have written", () => {
    expect(pasteInsertion({ ...base, pasted: "/home/p/src/a.ts" })).toEqual({
      text: "@src/a.ts ",
      caret: 10,
    });
  });

  it("fences a recognised snippet on its own line", () => {
    const result = pasteInsertion({
      ...base,
      value: "look at this",
      selectionStart: 12,
      selectionEnd: 12,
      pasted: "interface A {\n  b: string;\n}",
    });
    expect(result?.text).toBe(
      "look at this\n```typescript\ninterface A {\n  b: string;\n}\n```\n"
    );
  });

  it("doesn't add a leading newline when the caret already owns a line", () => {
    const result = pasteInsertion({
      ...base,
      value: "look\n",
      selectionStart: 5,
      selectionEnd: 5,
      pasted: "def a():\n    pass",
    });
    expect(result?.text).toBe("look\n```python\ndef a():\n    pass\n```\n");
  });

  it("replaces the selection rather than appending", () => {
    const result = pasteInsertion({
      ...base,
      value: "old text",
      selectionStart: 0,
      selectionEnd: 3,
      pasted: "src/a.ts",
    });
    expect(result?.text).toBe("@src/a.ts  text");
  });

  it("returns null for anything it shouldn't touch", () => {
    // Prose, a single line of non-code, and an empty clipboard all paste raw.
    expect(pasteInsertion({ ...base, pasted: "just some words here" })).toBe(null);
    expect(pasteInsertion({ ...base, pasted: "const a = 1" })).toBe(null);
    expect(pasteInsertion({ ...base, pasted: "   " })).toBe(null);
  });
});

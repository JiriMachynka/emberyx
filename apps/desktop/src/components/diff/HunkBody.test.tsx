import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { HunkBody } from "@/components/diff/HunkBody";

// React only batches through act() when it knows it's in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Identity highlighter: the tint and marker decisions are what's under test,
 *  not highlight.js. */
const plain = (code: string) => code;

const render = (text: string) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<HunkBody text={text} lang={null} highlight={plain} />);
  });
  return host;
};

describe("HunkBody", () => {
  it("tints added and removed lines and leaves context untinted", () => {
    const host = render("+added\n-removed\n context");
    const rows = Array.from(host.children);
    expect(rows).toHaveLength(3);
    expect(rows[0].className).toContain("border-emerald-500/50");
    expect(rows[0].className).toContain("bg-emerald-500/15");
    expect(rows[1].className).toContain("border-red-500/50");
    expect(rows[1].className).toContain("bg-red-500/15");
    expect(rows[2].className).not.toContain("emerald");
    expect(rows[2].className).not.toContain("red");
  });

  it("strips the marker off the code and shows it in the gutter", () => {
    const host = render("+added");
    const spans = host.children[0].querySelectorAll("span");
    expect(spans[0].textContent).toBe("+");
    expect(spans[1].textContent).toBe("added");
  });

  it("gives context lines a blank gutter rather than their first character", () => {
    const host = render(" context");
    const spans = host.children[0].querySelectorAll("span");
    expect(spans[0].textContent).toBe(" ");
    expect(spans[1].textContent).toBe("context");
  });

  it("renders diff headers as muted meta, not as code", () => {
    const host = render("@@ -1,2 +1,2 @@\nindex abc..def\ndiff --git a/x b/x");
    for (const row of Array.from(host.children)) {
      expect(row.className).toContain("text-muted-foreground");
      expect(row.querySelector("span")).toBeNull();
    }
  });

  it("keeps a blank line as its own row", () => {
    const host = render("+a\n\n+b");
    expect(host.children).toHaveLength(3);
    expect(host.children[1].className).toContain("pl-5");
    expect(host.children[1].querySelector("span")).toBeNull();
  });

  it("routes code through the injected highlighter", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <HunkBody
          text="+x"
          lang="typescript"
          highlight={(code, lang) => `${lang}:${code}`}
        />
      );
    });
    expect(host.textContent).toContain("typescript:x");
  });
});

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "@/components/Markdown";

const md = (text: string, streaming = false) =>
  render(<Markdown text={text} fontSize={13} streaming={streaming} />).container;

describe("Markdown code rendering", () => {
  it("renders a fence with no language as a plain block, not inline pills", () => {
    const el = md("```\n$ find src -type f\n(no output)\n```");
    const pre = el.querySelector("pre")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("$ find src -type f");
    expect(pre.textContent).toContain("(no output)");
    expect(el.querySelector("p code")).toBeNull();
  });

  it("renders a language fence as a code block", () => {
    const el = md("```bash\nfind src -type f\n```");
    const pre = el.querySelector("pre")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("find src -type f");
  });

  it("still styles genuine inline code as a pill", () => {
    const el = md("run `find src` first");
    expect(el.querySelector("pre")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("find src");
  });

  it("gives an inline file reference its filetype icon", () => {
    const el = md("look at `src/components/ChatPane.tsx` now");
    // Inline `code` is a string child; fence `code` is highlighted HTML, so
    // the file-reference path never sees the fence.
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      "/file-icons/react_ts.svg",
    );
    expect(el.textContent).toContain("src/components/ChatPane.tsx");
  });

  it("leaves inline code that only looks dotted alone", () => {
    const el = md("call `React.useState` here");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("React.useState");
  });

  it("keeps a fenced block out of the file-reference path", () => {
    const el = md("```ts\nsrc/a.ts\n```");
    expect(el.querySelector("pre")).not.toBeNull();
    expect(el.querySelector("img")).toBeNull();
  });
});

describe("Markdown GFM", () => {
  it("renders tables, strikethrough and task lists", () => {
    const el = md("| a |\n|---|\n| 1 |\n\n~~gone~~\n\n- [x] done");
    expect(el.querySelector("table td")?.textContent).toBe("1");
    expect(el.querySelector("del")?.textContent).toBe("gone");
    expect(el.querySelector("input[type=checkbox]")).not.toBeNull();
  });

  it("leaves raw HTML inert", () => {
    const el = md("<img src=x onerror=alert(1)> done");
    expect(el.querySelector("img")).toBeNull();
  });

  it("renders markdown, not raw markers, while the turn is still streaming", () => {
    const el = md("this is **bold** text", true);
    expect(el.querySelector("strong")?.textContent).toBe("bold");
    const text = el.querySelector(".chat-md")?.textContent ?? "";
    expect(text).toContain("bold");
    expect(text).not.toContain("**");
  });

  it("closes an incomplete fence so the code block paints as it streams", () => {
    const el = md("```ts\nconst x = 1", true);
    expect(el.querySelector("pre")).not.toBeNull();
    expect(el.querySelector("pre")?.textContent).toContain("const x = 1");
  });

  it("closes incomplete bold while the closer is still in flight", () => {
    const el = md("this is **bol", true);
    expect(el.querySelector("strong")?.textContent).toBe("bol");
    expect(el.querySelector(".chat-md")?.textContent).not.toContain("**");
  });
});

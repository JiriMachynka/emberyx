import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { Markdown } from "@/components/Markdown";

/**
 * Mounted on a bare root rather than through Testing Library: the renderer
 * may commit asynchronously (Shiki grammars, block splits). Poll until the
 * chat wrapper has children.
 */
const md = async (text: string, streaming = false) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <Markdown text={text} fontSize={13} streaming={streaming} />
  );
  for (let i = 0; i < 100 && !container.querySelector(".chat-md")?.children.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return container;
};

describe("Markdown code rendering", () => {
  it("renders a fence with no language as a plain block, not inline pills", async () => {
    const el = await md("```\n$ find src -type f\n(no output)\n```");
    const pre = el.querySelector("pre")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("$ find src -type f");
    expect(pre.textContent).toContain("(no output)");
    expect(el.querySelector("p code")).toBeNull();
  });

  it("renders a language fence as a code block", async () => {
    const el = await md("```bash\nfind src -type f\n```");
    const pre = el.querySelector("pre")!;
    expect(pre).not.toBeNull();
    expect(pre.textContent).toContain("find src -type f");
  });

  it("still styles genuine inline code as a pill", async () => {
    const el = await md("run `find src` first");
    expect(el.querySelector("pre")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("find src");
  });
});

describe("Markdown GFM", () => {
  it("renders tables, strikethrough and task lists", async () => {
    const el = await md("| a |\n|---|\n| 1 |\n\n~~gone~~\n\n- [x] done");
    expect(el.querySelector("table td")?.textContent).toBe("1");
    expect(el.querySelector("del")?.textContent).toBe("gone");
    expect(el.querySelector("input[type=checkbox]")).not.toBeNull();
  });

  it("leaves raw HTML inert", async () => {
    const el = await md("<img src=x onerror=alert(1)> done");
    expect(el.querySelector("img")).toBeNull();
  });

  it("closes markup left open by a partial stream", async () => {
    const el = await md("this is **bo", true);
    expect(el.querySelector("[data-streamdown=strong]")?.textContent).toBe("bo");
  });

  it("shows an incomplete fence immediately while streaming", async () => {
    const el = await md("```ts\nconst x = 1", true);
    expect(el.querySelector("[data-streamdown=code-block]")?.textContent).toContain(
      "const x = 1",
    );
  });
});

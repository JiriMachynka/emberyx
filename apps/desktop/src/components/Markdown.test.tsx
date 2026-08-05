import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { Markdown } from "@/components/Markdown";

/**
 * Mounted on a bare root rather than through Testing Library: comark parses
 * behind a Suspense boundary, and a suspended tree never resolves inside
 * Testing Library's `act` environment. Polls because React throttles the commit
 * that swaps the fallback for real content.
 */
const md = async (text: string) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(<Markdown text={text} fontSize={13} />);
  for (let i = 0; i < 100 && !container.querySelector(".chat-md")?.children.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return container;
};

describe("Markdown code rendering", () => {
  it("renders a fence with no language as a plain block, not inline pills", async () => {
    const el = await md("```\n$ find src -type f\n(no output)\n```");
    const code = el.querySelector("pre code")!;
    expect(code.className).toBe("hljs");
    expect(el.querySelector("pre .bg-muted")).toBeNull();
    expect(code.textContent).toBe("$ find src -type f\n(no output)");
  });

  it("highlights a fence that declares a language", async () => {
    const el = await md("```bash\nfind src -type f\n```");
    const code = el.querySelector("pre code")!;
    expect(code.className).toBe("hljs");
    expect(code.innerHTML).toContain("<span");
  });

  it("still styles genuine inline code as a pill", async () => {
    const el = await md("run `find src` first");
    const code = el.querySelector("code")!;
    expect(code.className).toContain("bg-muted");
    expect(el.querySelector("pre")).toBeNull();
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
    const el = await md("this is **bo");
    expect(el.querySelector("strong")?.textContent).toBe("bo");
  });
});

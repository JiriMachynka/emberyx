import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/Markdown";

const md = (text: string) => render(<Markdown text={text} fontSize={13} />).container;

describe("Markdown code rendering", () => {
  it("renders a fence with no language as a plain block, not inline pills", () => {
    const el = md("```\n$ find src -type f\n(no output)\n```");
    const code = el.querySelector("pre code")!;
    expect(code.className).toBe("hljs");
    expect(el.querySelector("pre .bg-muted")).toBeNull();
    expect(code.textContent).toBe("$ find src -type f\n(no output)");
  });

  it("highlights a fence that declares a language", () => {
    const el = md("```bash\nfind src -type f\n```");
    const code = el.querySelector("pre code")!;
    expect(code.className).toBe("hljs");
    expect(code.innerHTML).toContain("<span");
  });

  it("still styles genuine inline code as a pill", () => {
    const el = md("run `find src` first");
    const code = el.querySelector("code")!;
    expect(code.className).toContain("bg-muted");
    expect(el.querySelector("pre")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { TextWithFileRefs } from "@/components/FileRef";
import { LinkChip } from "@/components/LinkChip";
import { faviconSrc } from "@/lib/linkRef";

describe("LinkChip", () => {
  it("wears the site favicon and a shortened label", () => {
    const el = render(
      <LinkChip href="https://github.com/jiri/emberyx" />,
    ).container;
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      faviconSrc("github.com"),
    );
    expect(el.querySelector("a")?.textContent).toBe("github.com/jiri/emberyx");
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/jiri/emberyx",
    );
  });

  it("keeps custom link text", () => {
    const el = render(
      <LinkChip href="https://github.com/jiri/emberyx">repo</LinkChip>,
    ).container;
    expect(el.querySelector("a")?.textContent).toBe("repo");
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      faviconSrc("github.com"),
    );
  });

  it("shortens autolink text that is the URL itself", () => {
    const el = render(
      <LinkChip href="https://github.com/jiri/emberyx">
        https://github.com/jiri/emberyx
      </LinkChip>,
    ).container;
    expect(el.querySelector("a")?.textContent).toBe("github.com/jiri/emberyx");
  });

  it("leaves non-http links as a plain underline", () => {
    const el = render(<LinkChip href="mailto:a@b.com">mail</LinkChip>).container;
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("a")?.className).toContain("underline");
    expect(el.querySelector("a")?.textContent).toBe("mail");
  });
});

describe("TextWithFileRefs links", () => {
  it("renders a pasted URL as a favicon chip", () => {
    const el = render(
      <TextWithFileRefs text="see https://github.com/jiri/emberyx please" />,
    ).container;
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/jiri/emberyx",
    );
    expect(el.querySelector("img")?.getAttribute("src")).toBe(
      faviconSrc("github.com"),
    );
    expect(el.querySelector("a")?.textContent).toBe("github.com/jiri/emberyx");
  });
});

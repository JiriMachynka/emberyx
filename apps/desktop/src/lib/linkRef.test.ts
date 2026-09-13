import { describe, expect, it } from "vitest";
import {
  faviconSrc,
  isAutolinkText,
  linkLabel,
  parseHttpUrl,
} from "@/lib/linkRef";

describe("parseHttpUrl", () => {
  it("accepts http(s) and a scheme-less www", () => {
    expect(parseHttpUrl("https://github.com/jiri/emberyx")?.href).toBe(
      "https://github.com/jiri/emberyx",
    );
    expect(parseHttpUrl("http://localhost:5173/app")?.href).toBe(
      "http://localhost:5173/app",
    );
    expect(parseHttpUrl("www.example.com/x")?.href).toBe(
      "https://www.example.com/x",
    );
  });

  it("rejects the things that look like links but aren't web pages", () => {
    expect(parseHttpUrl("example.com")).toBeNull();
    expect(parseHttpUrl("mailto:a@b.com")).toBeNull();
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
    expect(parseHttpUrl("file:///tmp/a.ts")).toBeNull();
    expect(parseHttpUrl("https://example.com/a https://b.com")).toBeNull();
    expect(parseHttpUrl("")).toBeNull();
  });
});

describe("linkLabel", () => {
  it("drops the scheme, a trailing slash, and a leading www", () => {
    expect(linkLabel(new URL("https://www.github.com/jiri/emberyx/"))).toBe(
      "github.com/jiri/emberyx",
    );
    expect(linkLabel(new URL("https://example.com"))).toBe("example.com");
    expect(linkLabel(new URL("https://youtube.com/watch?v=abc"))).toBe(
      "youtube.com/watch?v=abc",
    );
    expect(linkLabel(new URL("http://localhost:5173/app"))).toBe(
      "localhost:5173/app",
    );
  });
});

describe("faviconSrc", () => {
  it("asks Google for the host's icon", () => {
    expect(faviconSrc("github.com")).toBe(
      "https://www.google.com/s2/favicons?domain=github.com&sz=32",
    );
  });
});

describe("isAutolinkText", () => {
  it("treats the URL written out as itself, slash or not", () => {
    const url = new URL("https://github.com/jiri/emberyx");
    expect(isAutolinkText("https://github.com/jiri/emberyx", url.href, url)).toBe(
      true,
    );
    expect(isAutolinkText("https://github.com/jiri/emberyx/", url.href, url)).toBe(
      true,
    );
    expect(isAutolinkText("the repo", url.href, url)).toBe(false);
  });
});

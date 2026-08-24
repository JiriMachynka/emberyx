import { describe, expect, it } from "vitest";
import { isLocalUrl, normalizePreviewUrl, portUrl } from "@/lib/preview";

describe("normalizePreviewUrl", () => {
  it("reads a bare port as a local dev server", () => {
    expect(normalizePreviewUrl("3000")).toBe("http://localhost:3000");
    expect(normalizePreviewUrl(" 5173 ")).toBe("http://localhost:5173");
  });

  it("fills in the scheme for a host:port", () => {
    expect(normalizePreviewUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePreviewUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080/");
  });

  it("keeps a full URL, path and all", () => {
    expect(normalizePreviewUrl("http://localhost:3000/admin")).toBe(
      "http://localhost:3000/admin"
    );
    expect(normalizePreviewUrl("https://example.com")).toBe("https://example.com/");
  });

  // The frame runs inside the app's own webview, so what loads in it is not
  // only a display concern.
  it("refuses anything that isn't a web page", () => {
    expect(normalizePreviewUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePreviewUrl("file:///etc/passwd")).toBeNull();
    expect(normalizePreviewUrl("data:text/html,<h1>hi</h1>")).toBeNull();
  });

  it("refuses input that can't be an address at all", () => {
    expect(normalizePreviewUrl("")).toBeNull();
    expect(normalizePreviewUrl("   ")).toBeNull();
    expect(normalizePreviewUrl("999999")).toBeNull();
    expect(normalizePreviewUrl("http://")).toBeNull();
  });
});

describe("isLocalUrl", () => {
  it("recognises the loopback names", () => {
    expect(isLocalUrl("http://localhost:3000")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalUrl("http://app.localhost:3000")).toBe(true);
  });

  // Mistaking production for your branch is the failure this guards against.
  it("flags anything else as not local", () => {
    expect(isLocalUrl("https://example.com")).toBe(false);
    expect(isLocalUrl("not a url")).toBe(false);
  });
});

describe("portUrl", () => {
  it("builds the address a detected port maps to", () => {
    expect(portUrl(5173)).toBe("http://localhost:5173");
  });
});

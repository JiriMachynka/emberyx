import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { PrLink, ThreadLinkProvider, isLinkedPr } from "@/components/PrLink";
import { setThreadMeta, threadMetaKey } from "@/lib/threadMeta";
import type { LinkedPr } from "@/lib/forge";

// React only batches through act() when it knows it's in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = "/home/p";
const THREAD = "t1";
const KEY = threadMetaKey(PROJECT, THREAD);

const PR: LinkedPr = {
  host: "github",
  iid: 7,
  url: "https://github.com/o/r/pull/7",
};

const mount = async (hrefs: string[]) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThreadLinkProvider value={{ projectPath: PROJECT, threadId: THREAD }}>
        {hrefs.map((href) => (
          <PrLink key={href} href={href}>
            {href}
          </PrLink>
        ))}
      </ThreadLinkProvider>
    );
  });
  return { container, root };
};

/** Right-click a rendered link to open its menu. */
const openMenu = async (anchor: Element) => {
  await act(async () => {
    anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
};

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("isLinkedPr", () => {
  it("matches on host and number, whatever the URL was", () => {
    expect(isLinkedPr(PR, { ...PR, url: "https://github.com/o/r/pull/7/files" })).toBe(
      true
    );
  });

  it("does not match another request, or nothing at all", () => {
    expect(isLinkedPr(PR, { ...PR, iid: 8 })).toBe(false);
    expect(isLinkedPr(PR, { ...PR, host: "gitlab" })).toBe(false);
    expect(isLinkedPr(undefined, PR)).toBe(false);
    expect(isLinkedPr(PR, null)).toBe(false);
  });
});

describe("ThreadLinkProvider", () => {
  it("reads the thread-meta store once, not once per link", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem");
    await mount([
      "https://github.com/o/r/pull/1",
      "https://github.com/o/r/pull/2",
      "https://github.com/o/r/pull/3",
      "https://github.com/o/r/pull/4",
    ]);
    const reads = spy.mock.calls.filter(([k]) => k === "emberyx.threadMeta").length;
    expect(reads).toBeLessThanOrEqual(2); // initial state + the effect's read
  });

  it("marks the linked request, and only that one", async () => {
    setThreadMeta(KEY, { linkedPr: PR });
    const { container } = await mount([
      "https://github.com/o/r/pull/7",
      "https://github.com/o/r/pull/8",
    ]);
    const [linked, other] = Array.from(container.querySelectorAll("a"));

    await openMenu(linked);
    expect(document.body.textContent).toContain("Unlink from thread");

    await openMenu(other);
    expect(document.body.textContent).toContain("Link pull request to thread");
  });

  it("picks up a link written after mount", async () => {
    const { container } = await mount(["https://github.com/o/r/pull/7"]);
    const anchor = container.querySelector("a");
    if (!anchor) throw new Error("no link rendered");

    await openMenu(anchor);
    expect(document.body.textContent).toContain("Link pull request to thread");

    // `setThreadMeta` dispatches `emberyx-thread-meta`; the provider re-reads on it.
    await act(async () => {
      setThreadMeta(KEY, { linkedPr: PR });
    });
    await openMenu(anchor);
    expect(document.body.textContent).toContain("Unlink from thread");
  });
});

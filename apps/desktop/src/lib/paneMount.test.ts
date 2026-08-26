import { describe, expect, it } from "vitest";
import { paneIsSticky, paneShouldMount } from "@/lib/paneMount";

describe("paneShouldMount", () => {
  it("always mounts the focused pane", () => {
    expect(paneShouldMount("s1", "s1", "idle")).toBe(true);
    expect(paneShouldMount("s1", "s1", undefined)).toBe(true);
  });

  it("keeps a hidden pane that is still working or waiting", () => {
    expect(paneShouldMount("s1", "s2", "working")).toBe(true);
    expect(paneShouldMount("s1", "s2", "waiting")).toBe(true);
  });

  it("drops a hidden pane once the turn has settled", () => {
    expect(paneShouldMount("s1", "s2", "idle")).toBe(false);
    expect(paneShouldMount("s1", "s2", undefined)).toBe(false);
  });
});

describe("paneIsSticky", () => {
  it("is only the live-turn statuses", () => {
    expect(paneIsSticky("working")).toBe(true);
    expect(paneIsSticky("waiting")).toBe(true);
    expect(paneIsSticky("idle")).toBe(false);
    expect(paneIsSticky(undefined)).toBe(false);
  });
});

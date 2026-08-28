import { describe, expect, it } from "vitest";
import { paneIsSticky, paneShouldMount, pushRecent } from "@/lib/paneMount";

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

describe("pushRecent", () => {
  it("puts the active session at the head", () => {
    expect(pushRecent([], "s1")).toEqual(["s1"]);
    expect(pushRecent(["s1"], "s2")).toEqual(["s2", "s1"]);
  });

  it("does not duplicate a session already in the list", () => {
    expect(pushRecent(["s2", "s1"], "s1")).toEqual(["s1", "s2"]);
  });

  it("evicts past the limit", () => {
    expect(pushRecent(["s3", "s2", "s1"], "s4", 3)).toEqual(["s4", "s3", "s2"]);
  });

  it("is idempotent so a render pass can call it", () => {
    const recent = ["s1"];
    expect(pushRecent(recent, "s1")).toBe(recent);
    expect(pushRecent(recent, null)).toBe(recent);
  });
});

describe("paneShouldMount with keep-alive", () => {
  it("keeps a recently visited settled pane mounted", () => {
    expect(paneShouldMount("s1", "s2", "idle", ["s2", "s1"])).toBe(true);
  });

  it("unmounts a settled pane once it falls out of the list", () => {
    expect(paneShouldMount("s1", "s2", "idle", ["s2", "s3"])).toBe(false);
  });
});

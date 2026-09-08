import { beforeEach, describe, expect, it } from "vitest";
import { clearRowSizes, rememberRowSizes, rowSize } from "@/lib/rowSizes";

describe("rowSizes", () => {
  beforeEach(clearRowSizes);

  it("hands a remembered height back to the next mount of the same thread", () => {
    rememberRowSizes("s1", [
      ["turn:a", 420],
      ["turn:b", 96],
    ]);
    expect(rowSize("s1", "turn:a")).toBe(420);
    expect(rowSize("s1", "turn:b")).toBe(96);
  });

  it("keeps threads apart and misses on an unknown row", () => {
    rememberRowSizes("s1", [["turn:a", 420]]);
    expect(rowSize("s2", "turn:a")).toBeUndefined();
    expect(rowSize("s1", "turn:z")).toBeUndefined();
    expect(rowSize("s1", undefined)).toBeUndefined();
  });

  // A row that has not been laid out yet measures 0; storing that would pin the
  // next visit's estimate to nothing and undo the whole point.
  it("ignores measurements that are not a real height", () => {
    rememberRowSizes("s1", [
      ["turn:a", 0],
      ["turn:b", Number.NaN],
      ["turn:c", -12],
    ]);
    expect(rowSize("s1", "turn:a")).toBeUndefined();
    expect(rowSize("s1", "turn:b")).toBeUndefined();
    expect(rowSize("s1", "turn:c")).toBeUndefined();
  });

  it("takes the latest measurement of a row", () => {
    rememberRowSizes("s1", [["turn:a", 420]]);
    rememberRowSizes("s1", [["turn:a", 380]]);
    expect(rowSize("s1", "turn:a")).toBe(380);
  });

  // The cache is module state shared by every pane that ever opened: both
  // bounds have to hold or a long session grows it without limit.
  it("drops the oldest rows past the per-thread bound", () => {
    const many = Array.from(
      { length: 600 },
      (_, i) => [`turn:${i}`, 100 + i] as const
    );
    rememberRowSizes("s1", many);
    expect(rowSize("s1", "turn:0")).toBeUndefined();
    expect(rowSize("s1", "turn:599")).toBe(699);
  });

  it("drops the coldest thread past the thread bound", () => {
    for (let i = 0; i < 9; i += 1) {
      rememberRowSizes(`s${i}`, [["turn:a", 100 + i]]);
    }
    expect(rowSize("s0", "turn:a")).toBeUndefined();
    expect(rowSize("s8", "turn:a")).toBe(108);
  });

  it("counts a read as use, so the thread being revisited is not the one evicted", () => {
    for (let i = 0; i < 8; i += 1) {
      rememberRowSizes(`s${i}`, [["turn:a", 100 + i]]);
    }
    // s0 is the coldest by insertion order — reading it makes s1 the coldest.
    expect(rowSize("s0", "turn:a")).toBe(100);
    rememberRowSizes("s8", [["turn:a", 108]]);
    expect(rowSize("s0", "turn:a")).toBe(100);
    expect(rowSize("s1", "turn:a")).toBeUndefined();
  });
});

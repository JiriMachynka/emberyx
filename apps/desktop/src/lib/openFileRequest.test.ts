import { describe, expect, it } from "vitest";
import {
  latestOpenFile,
  requestOpenFile,
  takeOpenFileRequest,
} from "@/lib/openFileRequest";

describe("openFileRequest", () => {
  it("keeps the latest path after take, so Explorer can remount onto it", () => {
    requestOpenFile("/p/src/a.ts");
    expect(takeOpenFileRequest()).toBe("/p/src/a.ts");
    expect(takeOpenFileRequest()).toBeNull();
    expect(latestOpenFile()).toBe("/p/src/a.ts");
  });
});

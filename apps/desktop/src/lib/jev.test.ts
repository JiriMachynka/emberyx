import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { guardActivity, guardOutput, secretish, skillWireText } from "@/lib/jev";
import { useActivityRiskStore } from "@/lib/activityRisk";
import type { ActivityItem } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const row = (over: Partial<ActivityItem>): ActivityItem => ({
  id: "t1",
  kind: "command",
  title: "rm -rf build",
  failed: false,
  complete: false,
  ...over,
});

describe("skillWireText", () => {
  it("leaves the prompt alone when no skill was chosen", () => {
    expect(skillWireText("fix the test", null)).toBe("fix the test");
  });

  it("prefixes a hint without rewriting the user's words", () => {
    expect(skillWireText("fix the test", "fe-design")).toContain("fe-design");
    expect(skillWireText("fix the test", "fe-design").endsWith("fix the test")).toBe(true);
  });
});

describe("secretish", () => {
  it("catches known credential shapes", () => {
    expect(secretish("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(secretish("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(secretish("api_key = 1234")).toBe(true);
  });

  it("catches a long high-entropy run", () => {
    expect(secretish("token sk-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(secretish("a".repeat(40))).toBe(true);
  });

  it("leaves ordinary output alone", () => {
    expect(secretish("build finished in 1.2s")).toBe(false);
  });
});

describe("guardActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useActivityRiskStore.setState({ risks: {} });
  });

  it("asks Jev about a command and stores the label it returns", async () => {
    vi.mocked(invoke).mockResolvedValue("destructive");
    guardActivity(row({ id: "g1" }));
    await vi.waitFor(() =>
      expect(useActivityRiskStore.getState().risks.g1).toBe("destructive")
    );
    expect(invoke).toHaveBeenCalledWith("typesafe_call_risk", {
      title: "rm -rf build",
      description: null,
      toolKind: "command",
    });
  });

  it("never judges a read", () => {
    guardActivity(row({ id: "g2", kind: "fileRead", title: "src/app.ts" }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("judges a row once, however many snapshots arrive", () => {
    vi.mocked(invoke).mockResolvedValue(null);
    guardActivity(row({ id: "g3" }));
    guardActivity(row({ id: "g3" }));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("ignores a label it does not recognise", async () => {
    vi.mocked(invoke).mockResolvedValue("something-new");
    guardActivity(row({ id: "g4" }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(useActivityRiskStore.getState().risks.g4).toBeUndefined();
  });
});

describe("guardOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useActivityRiskStore.setState({ risks: {} });
  });

  it("confirms a candidate secret only after a local shape match", async () => {
    vi.mocked(invoke).mockResolvedValue("secret");
    const secret = row({ id: "o1", complete: true, output: "token = sk-abcdefghijklmnopqrstuvwxyz" });
    guardOutput(secret);
    await vi.waitFor(() =>
      expect(useActivityRiskStore.getState().risks.o1).toBe("secret")
    );
  });

  it("does not call Jev for output that looks ordinary", () => {
    guardOutput(row({ id: "o2", complete: true, output: "42 tests passed" }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("waits for the output to finish", () => {
    guardOutput(row({ id: "o3", complete: false, output: "AKIAIOSFODNN7EXAMPLE" }));
    expect(invoke).not.toHaveBeenCalled();
  });
});

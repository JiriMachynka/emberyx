import { describe, expect, it } from "vitest";
import {
  truncateBeforeCheckpoint,
  turnsToDrop,
} from "@/lib/conversationRewind";

const u = (checkpointId?: string) =>
  ({ role: "user" as const, checkpointId });
const a = () => ({ role: "assistant" as const });

describe("turnsToDrop", () => {
  it("counts user turns from the checkpoint through the end", () => {
    const messages = [u("c1"), a(), u("c2"), a(), u("c3"), a()];
    expect(turnsToDrop(messages, "c2")).toBe(2);
    expect(turnsToDrop(messages, "c3")).toBe(1);
    expect(turnsToDrop(messages, "c1")).toBe(3);
  });

  it("is null when the checkpoint is not in the transcript", () => {
    expect(turnsToDrop([u("c1"), a()], "nope")).toBeNull();
    expect(turnsToDrop([], "c1")).toBeNull();
  });
});

describe("truncateBeforeCheckpoint", () => {
  it("keeps only what happened before the reverted turn", () => {
    const messages = [u("c1"), a(), u("c2"), a()];
    expect(truncateBeforeCheckpoint(messages, "c2")).toEqual([u("c1"), a()]);
    expect(truncateBeforeCheckpoint(messages, "c1")).toEqual([]);
  });

  it("returns the same array when the checkpoint is missing", () => {
    const messages = [u("c1"), a()];
    expect(truncateBeforeCheckpoint(messages, "nope")).toBe(messages);
  });
});

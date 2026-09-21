/**
 * The mock transport behind the dev-only Mockup session. Returns the same
 * shape as the real transports, so `ChatPane` renders it unchanged — nothing
 * spawns, nothing touches Tauri.
 *
 * The canned conversation mounts settled; `send` plays a scripted live turn so
 * the states a static transcript cannot show are demoable too: the working
 * clock, streaming text, tool rows arriving incomplete and settling, a
 * permission prompt, and an `ask_user` picker. Every timer is cancelled by
 * `stop`, unmount, and `rewind`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatImage,
  ChatMessage,
  ChatStatus,
  ChatUsage,
  PermissionDecision,
  PendingAsk,
  PendingPermission,
} from "@/hooks/useAgentChat";
import { notifyPlanNothing } from "@/lib/chatSession";
import {
  MOCKUP_LIVE_ASSISTANT_ID,
  mockupAsk,
  mockupMessages,
} from "@/lib/mockupChat";
import type { ActivityItem } from "@/types";

const THINKING_MS = 900;
const CHUNK_MS = 60;
const TOOL_MS = 1300;

const turnThinking =
  "Reproduce first: profile a real turn, confirm the publish-per-token path is the hot one, then batch at the publisher rather than memoizing every subscriber.";

const turnAnswer =
  "Confirmed — profiling shows the publish-per-token path dominates. I'm batching token paints behind `requestAnimationFrame` in the store, which collapses the burst into one paint per frame. Running the focused suite next.";

const scriptedCommand = "bun run --cwd apps/desktop test -- useAgentChat";

export function useMockChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(mockupMessages);
  // Mounts mid-turn, not idle: the working surface — the clock under the
  // transcript, a boxed running tool, the turn's file tree — is the one state
  // a settled transcript cannot show, and waiting for the scripted turn to
  // reach that frame is a poor way to look at it. Stop settles it.
  const [status, setStatus] = useState<ChatStatus>("tool");
  const [usage, setUsage] = useState<ChatUsage>({});
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null);
  // Mounts with the harness's question already on screen: an `ask_user` call
  // replaces the composer, and it is the surface hardest to see otherwise —
  // the scripted turn only reaches it after a permission decision. Answering
  // it settles the turn the mockup opened on.
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(mockupAsk);

  // Whether a scripted turn is in flight. Only that turn is rewindable — the
  // canned turns are history, and a rewind must not eat those.
  const inFlightRef = useRef(true);
  const assistantIdRef = useRef(MOCKUP_LIVE_ASSISTANT_ID);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const applyStatus = useCallback((s: ChatStatus) => setStatus(s), []);

  const patch = useCallback(
    (id: string, f: (m: ChatMessage) => ChatMessage) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? f(m) : m)));
    },
    []
  );

  /** Rows are whole snapshots; an update is a replace by id. */
  const upsertRow = useCallback((row: ActivityItem) => {
    patch(assistantIdRef.current, (m) => {
      const rows = m.activities ?? [];
      const next = rows.some((a) => a.id === row.id)
        ? rows.map((a) => (a.id === row.id ? row : a))
        : [...rows, row];
      return { ...m, activities: next };
    });
  }, [patch]);

  const respondRef = useRef<(decision: PermissionDecision) => void>(() => {});

  const stop = useCallback(() => {
    if (!inFlightRef.current) return;
    inFlightRef.current = false;
    clearTimers();
    setPendingPermission(null);
    setPendingAsk(null);
    patch(assistantIdRef.current, (m) => ({ ...m, streaming: false }));
    applyStatus("idle");
  }, [applyStatus, clearTimers, patch, setPendingAsk, setPendingPermission]);

  const rewind = useCallback((): { text: string; images?: ChatImage[] } | null => {
    if (!inFlightRef.current) return null;
    // The turn the mockup opens on is canned history like the rest — rewinding
    // it would delete a demo the pane cannot rebuild.
    if (assistantIdRef.current === MOCKUP_LIVE_ASSISTANT_ID) return null;
    inFlightRef.current = false;
    clearTimers();
    setPendingPermission(null);
    setPendingAsk(null);
    // Read the draft off this render's messages — a setState updater runs
    // too late for its result to be returned from here.
    const idx = messages.map((m) => m.role).lastIndexOf("user");
    const restored =
      idx === -1
        ? null
        : { text: messages[idx].text, images: messages[idx].images };
    setMessages((prev) => prev.slice(0, idx === -1 ? prev.length : idx));
    applyStatus("idle");
    return restored;
  }, [applyStatus, clearTimers, messages, setPendingAsk, setPendingPermission]);

  const send = useCallback(
    (text: string, images?: ChatImage[]) => {
      if (inFlightRef.current || !text.trim()) return;
      inFlightRef.current = true;
      clearTimers();
      const assistantId = `mock-live-a-${messages.length}`;
      assistantIdRef.current = assistantId;
      const startTs = Date.now();
      setMessages((prev) => [
        ...prev,
        {
          id: `mock-live-u-${prev.length}`,
          role: "user",
          text,
          thinking: "",
          tools: [],
          streaming: false,
          images,
        },
        {
          id: assistantId,
          role: "assistant",
          text: "",
          thinking: "",
          tools: [],
          streaming: true,
        },
      ]);
      applyStatus("thinking");

      let t = 0;
      later(THINKING_MS, () => {
        applyStatus("streaming");
        patch(assistantId, (m) => ({ ...m, thinking: turnThinking }));
      });
      t += THINKING_MS;
      const chunks = turnAnswer.match(/.{1,14}(\s|$)/g) ?? [turnAnswer];
      chunks.forEach((chunk, i) => {
        later(t + (i + 1) * CHUNK_MS, () => {
          patch(assistantId, (m) => ({ ...m, text: m.text + chunk }));
        });
      });
      t += chunks.length * CHUNK_MS;

      // A read lands, then a command runs — each arriving incomplete and
      // settling, which is what a running tool card looks like.
      const readRow: ActivityItem = {
        id: "mock-live-r1",
        kind: "fileRead",
        title: "Read",
        displayTarget: "apps/desktop/src/lib/agentStore.ts",
        failed: false,
        complete: true,
        output: "  412 lines",
      };
      later(t, () => {
        applyStatus("tool");
        upsertRow({ ...readRow, complete: false });
      });
      t += TOOL_MS;
      later(t, () => upsertRow(readRow));

      const commandRow = (failed: boolean, output: string): ActivityItem => ({
        id: "mock-live-r2",
        kind: "command",
        title: "Bash",
        displayTarget: scriptedCommand,
        failed,
        complete: true,
        output,
      });
      later(t, () => upsertRow({ ...commandRow(false, ""), complete: false }));
      t += 600;
      later(t, () => {
        setPendingPermission({
          requestId: "mock-perm-1",
          toolName: "Bash",
          input: { command: scriptedCommand },
          suggestions: [],
          toolUseId: "mock-live-r2",
        });
        applyStatus("awaiting_permission");
      });

      // From the permission prompt on, playback continues on the user's
      // decision — deny fails the command row, allow settles it.
      respondRef.current = (decision: PermissionDecision) => {
        const denied = decision === "deny";
        setPendingPermission(null);
        applyStatus("tool");
        later(400, () => {
          upsertRow(
            commandRow(
              denied,
              denied
                ? "User declined this command."
                : "Test Files  1 passed (1)\n     Tests  14 passed (14)"
            )
          );
          upsertRow({
            id: "mock-live-r3",
            kind: "reasoning",
            title: "Thinking",
            complete: true,
            failed: false,
            output: denied
              ? "The suite can't run without the command, so report the change and stop."
              : "Suite is green with the batching in place. One more check: the turn clock renders from the first painted frame, not from this settle.",
          });
          applyStatus("streaming");
        });
        later(1600, () => {
          patch(assistantId, (m) => ({
            ...m,
            streaming: false,
            startedAt: startTs,
            endedAt: Date.now(),
          }));
          setUsage({
            inputTokens: 51_234,
            outputTokens: 1_873,
            contextTokens: 143_296,
            contextWindow: 200_000,
            model: "claude-sonnet-4-5",
            costUsd: 0.4122,
          });
          setPendingAsk(mockupAsk);
          applyStatus("awaiting_answer");
        });
      };
    },
    [applyStatus, clearTimers, later, messages.length, patch, setPendingAsk, setPendingPermission, upsertRow]
  );

  const respond = useCallback((decision: PermissionDecision) => {
    respondRef.current(decision);
  }, []);

  const answerAsk = useCallback(
    (answer: string) => {
      setPendingAsk(null);
      applyStatus("streaming");
      later(500, () => {
        patch(assistantIdRef.current, (m) => ({
          ...m,
          text: `${m.text}\n\nPutting it next to the hook, then — same file the selectors are tested in.`,
        }));
        inFlightRef.current = false;
        applyStatus("idle");
      });
      void answer;
    },
    [applyStatus, later, patch, setPendingAsk]
  );

  return {
    messages,
    status,
    usage,
    ready: true,
    // Nothing to wake: the mock has no process to hold asleep.
    asleep: false,
    wake: () => {},
    // No provider thread id — the pane never registers the mock with the
    // sidebar or offers to resume it.
    threadId: null,
    send,
    compact: () => {},
    queued: 0,
    // No busy queue of its own; Escape rewinds the scripted turn instead.
    queue: null,
    stop,
    restart: () => {},
    exitReason: null,
    modelError: null,
    rewind,
    revertTurn: async () => {},
    pendingPermission,
    respond,
    pendingPlan: null,
    answerPlan: notifyPlanNothing,
    pendingAsk,
    answerAsk,
    hasMore: false,
    loadingOlder: false,
    loadOlder: async () => false,
  };
}

/**
 * A dev-only showcase conversation: every message shape the chat pane can
 * render, as canned data behind a fixed session id. It feeds the real
 * `ChatPane` through `useMockChat`, so nothing about transcript markup is
 * duplicated — this file is data, and only data.
 *
 * Shapes are copied from what the real producers emit: settled rows mirror
 * `from_tool_call`/`from_reasoning` in `activity.rs` (display fields
 * precomputed, `arguments` JSON-encoded except for commands, where the target
 * already is the command), and the fallback turn mirrors what `parseTranscript`
 * builds for a replayed transcript (thinking + tools, no activity stream).
 */

import type {
  CheckpointRangeContents,
  CheckpointRangeFile,
} from "@/lib/checkpoints";
import type { ChatImage, ChatMessage, ToolCall } from "@/hooks/useAgentChat";
import type { ActivityItem } from "@/types";

/** Fixed id so `useChatSession` can route the pane to the mock transport. */
export const MOCKUP_SESSION_ID = "mockup";
export const MOCKUP_LABEL = "Mockup";

/** The turn snapshot the Review block hangs off. Nothing exists behind it in
 *  git — the data below answers in its place, dev-only. */
export const MOCK_CHECKPOINT_ID = "mock-checkpoint-1";

/** 1×1 transparent PNG, for the image-attachment shape. */
const TINY_PNG: ChatImage = {
  id: "mock-img-1",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
};

const row = (a: Partial<ActivityItem> & Pick<ActivityItem, "id" | "kind" | "title">): ActivityItem => ({
  failed: false,
  complete: true,
  ...a,
});

const tool = (t: Partial<ToolCall> & Pick<ToolCall, "id" | "name" | "input">): ToolCall => ({
  partial: "",
  ...t,
});

/** Turn 1 — the full ordered activity stream: every kind, a failure, a
 *  subagent, the todo card, work timing and usage. */
const profileTurnAssistant: ChatMessage = {
  id: "mock-m2",
  role: "assistant",
  text: "The re-render was coming from `useAgentChat` publishing every token into the shared store — I moved the hot path to a ref and batched the paints. Transcripts now repaint once per frame instead of once per token, and the fix is covered by a regression test.",
  thinking: "",
  streaming: false,
  provider: "claude",
  model: "claude-sonnet-4-5",
  startedAt: Date.now() - 62_000,
  endedAt: Date.now() - 15_000,
  tools: [
    tool({
      id: "mock-a8",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Profile the re-render path", status: "completed" },
          { content: "Move token paints to a ref", status: "completed" },
          { content: "Add a regression test", status: "in_progress" },
          { content: "Verify with the full suite", status: "pending" },
        ],
      },
      result: "Todos have been modified successfully.",
    }),
    tool({
      id: "mock-a11",
      name: "Task",
      input: {
        subagent_type: "general-purpose",
        description: "Review batched paint change",
        prompt: "Review the diff in apps/desktop/src/lib/agentStore.ts for stale-closure bugs around the new ref-based token path.",
      },
      result: "No issues found. The ref is advanced during render and read in the batched paint, which matches how the last committed turn reads it.",
    }),
  ],
  activities: [
    row({
      id: "mock-a1",
      kind: "reasoning",
      title: "Thinking",
      output:
        "The complaint is per-token re-renders. The store publishes a new snapshot per token and every subscribing component repaints — so the fix is batching at the publisher, not memoizing subscribers.",
    }),
    row({
      id: "mock-a2",
      kind: "fileSearch",
      title: "Grep",
      displayTarget: "setMessages",
      arguments: JSON.stringify({ pattern: "setMessages", path: "apps/desktop/src" }, null, 2),
      output: "apps/desktop/src/hooks/useAgentChat.ts:  41 matches",
    }),
    row({
      id: "mock-a3",
      kind: "fileList",
      title: "Glob",
      displayTarget: "hooks/**/*.ts",
      arguments: JSON.stringify({ pattern: "apps/desktop/src/hooks/**/*.ts" }, null, 2),
      output: "useAgentChat.ts\nuseCodexChat.ts\nuseAcpChat.ts\nuseChatSession.ts",
    }),
    row({
      id: "mock-a4",
      kind: "fileRead",
      title: "Read",
      displayTarget: "apps/desktop/src/hooks/useAgentChat.ts",
      arguments: JSON.stringify(
        { file_path: "/Users/jiri/Desktop/Personal/emberyx/apps/desktop/src/hooks/useAgentChat.ts" },
        null,
        2
      ),
      output: "  2000 lines",
    }),
    row({
      id: "mock-a5",
      kind: "command",
      title: "Bash",
      displayTarget: "bun run --cwd apps/desktop test -- useAgentChat",
      output: "Test Files  3 passed (3)\n     Tests  42 passed (42)",
    }),
    row({
      id: "mock-a6",
      kind: "command",
      title: "Bash",
      displayTarget: "bun run --cwd apps/desktop build",
      output: "error TS2322: Type 'string' is not assignable to type 'number'.",
      failed: true,
    }),
    row({
      id: "mock-a7",
      kind: "reasoning",
      title: "Thinking",
      output:
        "The build failure is the same ref the store change introduced. Straightening the type costs less than silencing it — fix at the source.",
    }),
    row({
      id: "mock-a8",
      kind: "plan",
      title: "TodoWrite",
      arguments: JSON.stringify(
        {
          todos: [
            { content: "Profile the re-render path", status: "completed" },
            { content: "Move token paints to a ref", status: "completed" },
            { content: "Add a regression test", status: "in_progress" },
          ],
        },
        null,
        2
      ),
    }),
    row({
      id: "mock-a9",
      kind: "fileChange",
      title: "Edit",
      displayTarget: "apps/desktop/src/lib/agentStore.ts",
      displayDescription: "Batch token paints behind requestAnimationFrame",
      // Claude never reports line counts — the normalizer leaves them absent
      // rather than guessing from an edit's input. The Review card gets its
      // numbers from git instead.
      fileChanges: [{ path: "apps/desktop/src/lib/agentStore.ts" }],
      arguments: JSON.stringify(
        {
          file_path: "/Users/jiri/Desktop/Personal/emberyx/apps/desktop/src/lib/agentStore.ts",
          old_string: "/* … */",
          new_string: "/* … */",
        },
        null,
        2
      ),
    }),
    row({
      id: "mock-a10",
      kind: "fileChange",
      title: "Edit",
      displayTarget: "apps/desktop/src/hooks/useAgentChat.ts",
      displayDescription: "Straighten the ref's type at the source",
      fileChanges: [{ path: "apps/desktop/src/hooks/useAgentChat.ts" }],
      arguments: JSON.stringify(
        {
          file_path: "/Users/jiri/Desktop/Personal/emberyx/apps/desktop/src/hooks/useAgentChat.ts",
          old_string: "/* … */",
          new_string: "/* … */",
        },
        null,
        2
      ),
      autoApproved: true,
    }),
    row({
      id: "mock-a11",
      kind: "tool",
      title: "Task",
      displayDescription: "Review batched paint change",
      arguments: JSON.stringify(
        {
          subagent_type: "general-purpose",
          description: "Review batched paint change",
          prompt: "Review the diff in apps/desktop/src/lib/agentStore.ts for stale-closure bugs.",
        },
        null,
        2
      ),
    }),
    row({
      id: "mock-a12",
      kind: "search",
      title: "WebSearch",
      displayTarget: "react requestAnimationFrame batching state updates",
      arguments: JSON.stringify({ query: "react requestAnimationFrame batching state updates" }, null, 2),
      output: "React batches state updates inside timers and event handlers automatically.",
    }),
  ],
};

const profileTurnUser: ChatMessage = {
  id: "mock-m1",
  role: "user",
  text: "The chat transcript re-renders on every token — profile it and fix the worst offender.",
  thinking: "",
  tools: [],
  streaming: false,
  checkpointId: MOCK_CHECKPOINT_ID,
};

/** Turn 2 — a replayed-transcript-shaped turn (no activity stream: thinking +
 *  tools fallback path), attributed to Codex, with an image on the user side. */
const codexTurnUser: ChatMessage = {
  id: "mock-m3",
  role: "user",
  text: "This screenshot of the diff tab — why is the gutter misaligned on the last hunk?",
  thinking: "",
  tools: [],
  streaming: false,
  images: [TINY_PNG],
};

const codexTurnAssistant: ChatMessage = {
  id: "mock-m4",
  role: "assistant",
  text: "The gutter had a fixed width while the code column didn't — set both from the same grid template and they hold together at any zoom.",
  thinking:
    "The screenshot shows the line numbers drifting left as the hunk grows. A shared grid template for gutter and code columns should pin them.",
  streaming: false,
  provider: "codex",
  model: "gpt-5.2-codex",
  startedAt: Date.now() - 28_000,
  endedAt: Date.now() - 9_000,
  tools: [
    tool({
      id: "mock-t1",
      name: "Bash",
      input: { command: "rg -n 'gutter' apps/desktop/src/components/diff" },
      result: "apps/desktop/src/components/diff/DiffView.tsx:88:  <div className=\"gutter\" style={{ width: 48 }}>",
    }),
    tool({
      id: "mock-t2",
      name: "Edit",
      input: {
        file_path: "/Users/jiri/Desktop/Personal/emberyx/apps/desktop/src/components/diff/DiffView.tsx",
        old_string: '<div className="gutter" style={{ width: 48 }}>',
        new_string: '<div className="gutter" style={{ gridColumn: "1" }}>',
      },
      result: "The file has been edited successfully.",
    }),
  ],
};

/** Turn 3 — the minimal settled exchange, no work recorded. */
const plainTurnUser: ChatMessage = {
  id: "mock-m5",
  role: "user",
  text: "Thanks — that was exactly it. One more: can the same fix go into the review panel?",
  thinking: "",
  tools: [],
  streaming: false,
};

const plainTurnAssistant: ChatMessage = {
  id: "mock-m6",
  role: "assistant",
  text: [
    "Yes — the review panel renders through the same diff library, so the grid template applies there too.",
    "",
    "It is a one-line change to the shared `@pierre/diffs` theme file:",
    "",
    "```css",
    ".pierre-diffs {",
    "  --diff-gutter-template: 48px 1fr;",
    "}",
    "```",
  ].join("\n"),
  thinking: "",
  tools: [],
  streaming: false,
  provider: "codex",
  model: "gpt-5.2-codex",
  startedAt: Date.now() - 6_000,
  endedAt: Date.now() - 4_000,
};

/** Turn 4 — the JSON dump. Models answer structured requests with a fenced
 *  payload often enough that the transcript has to render one well: long
 *  lines, deep nesting, and no prose to break it up. */
const payloadTurnUser: ChatMessage = {
  id: "mock-m9",
  role: "user",
  text: "Give me the resolved launch config for this project as JSON.",
  thinking: "",
  tools: [],
  streaming: false,
};

const payloadTurnAssistant: ChatMessage = {
  id: "mock-m10",
  role: "assistant",
  text: [
    "Here is what the backend resolves to for this project — the pinned backend wins over the global default, and the MCP server list is the one the spawn actually passes through `--mcp-config`.",
    "",
    "```json",
    "{",
    '  "backend": "claude",',
    '  "resolvedFrom": "project-pin",',
    '  "model": "claude-sonnet-4-5",',
    '  "permissionMode": "acceptEdits",',
    '  "launch": {',
    '    "command": "claude",',
    '    "args": ["-p", "--input-format", "stream-json", "--include-partial-messages"],',
    '    "configDir": null,',
    '    "env": { "MAX_THINKING_TOKENS": "0" }',
    "  },",
    '  "mcpServers": [',
    '    { "name": "emberyx-ask", "transport": { "kind": "stdio", "command": "emberyx", "args": ["ask"] } },',
    '    { "name": "context7", "transport": { "kind": "http", "url": "https://mcp.context7.com/mcp" } }',
    "  ],",
    '  "capabilities": { "usage": true, "compact": true, "slashCommands": true, "hooks": true }',
    "}",
    "```",
    "",
    "The `env` entry is the draft path's, not yours — it only applies to the warm child that writes commit messages.",
  ].join("\n"),
  thinking: "",
  streaming: false,
  provider: "claude",
  model: "claude-sonnet-4-5",
  startedAt: Date.now() - 21_000,
  endedAt: Date.now() - 12_000,
  tools: [],
  activities: [
    row({
      id: "mock-a30",
      kind: "tool",
      title: "ReadConfig",
      displayTarget: "launch config",
      // The other place a payload shows up: a tool's arguments, in the row's
      // disclosure body rather than in the answer.
      arguments: JSON.stringify(
        { scope: "project", include: ["backend", "launch", "mcpServers"] },
        null,
        2
      ),
      output: '{"backend":"claude","resolvedFrom":"project-pin"}',
    }),
  ],
};

/** Turn 4 — the state a static transcript cannot otherwise show: a turn still
 *  running. The mockup opens on it (`useMockChat` mounts busy), so the working
 *  surface — the ticking clock under the transcript, a tool boxed while it
 *  runs, the file tree accumulating behind it — can be looked at without
 *  sending anything and waiting for the scripted turn to reach that frame.
 *
 *  Its shape is what makes it live: the assistant is `streaming`, the last row
 *  is `complete: false`, and there is no `endedAt`. Pressing stop settles it
 *  into an ordinary finished turn. */
const workingTurnUser: ChatMessage = {
  id: "mock-m7",
  role: "user",
  text: "Make the app boot faster — find what the first screen actually waits on.",
  thinking: "",
  tools: [],
  streaming: false,
};

const workingTurnAssistant: ChatMessage = {
  id: "mock-m8",
  role: "assistant",
  // Mid-sentence on purpose: this is what streamed text looks like before the
  // turn settles, not a finished answer.
  text: "Timed each stage rather than guessing. The webview is up in under a second, so the wait is behind it — checking what the first spawn",
  thinking: "",
  streaming: true,
  provider: "claude",
  model: "claude-sonnet-4-5",
  startedAt: Date.now() - 7_400,
  tools: [],
  activities: [
    row({
      id: "mock-a20",
      kind: "reasoning",
      title: "Thinking",
      output:
        "Boot is three stages that could each own the seven seconds: the dev server's module graph, the Rust setup, and whatever the first agent spawn blocks on. Measure all three before touching any of them.",
    }),
    // Consecutive reads in one folder — what the turn's file tree groups.
    row({
      id: "mock-a21",
      kind: "fileRead",
      title: "Read",
      displayTarget: "apps/desktop/src-tauri/src/lib.rs",
      output: "  311 lines",
    }),
    row({
      id: "mock-a22",
      kind: "fileRead",
      title: "Read",
      displayTarget: "apps/desktop/src-tauri/src/pty.rs",
      output: "  486 lines",
    }),
    row({
      id: "mock-a23",
      kind: "fileRead",
      title: "Read",
      displayTarget: "apps/desktop/src-tauri/src/agent.rs",
      output: "  612 lines",
    }),
    row({
      id: "mock-a24",
      kind: "command",
      title: "Bash",
      displayTarget: "cargo test times_a_real_restore -- --ignored --nocapture",
      output: "store open 2.7ms, attach_store 143.0ms, restore 48.7ms",
    }),
    // The running row: no output, not complete. This is the boxed tool card
    // and what keeps the turn clock ticking.
    row({
      id: "mock-a25",
      kind: "command",
      title: "Bash",
      displayTarget: "zsh -lic env",
      complete: false,
    }),
  ],
};

export const mockupMessages: ChatMessage[] = [
  profileTurnUser,
  profileTurnAssistant,
  codexTurnUser,
  codexTurnAssistant,
  plainTurnUser,
  plainTurnAssistant,
  payloadTurnUser,
  payloadTurnAssistant,
  workingTurnUser,
  workingTurnAssistant,
];

/** The id of the in-flight assistant message, so the mock transport can settle
 *  the turn the transcript opens on. */
export const MOCKUP_LIVE_ASSISTANT_ID = workingTurnAssistant.id;

/** The `ask_user` question the scripted turn ends on, so the picker renders. */
export const mockupAsk = {
  id: "mock-ask-1",
  questions: [
    {
      question: "Where should the regression test live?",
      header: "Test placement",
      multiSelect: false,
      options: [
        { label: "Next to the hook", description: "Colocated as useAgentChat.test.tsx" },
        { label: "With the store tests", description: "agentStore.test.ts already covers selectors" },
      ],
    },
  ],
};

/**
 * The Review block's data: one turn's file delta, the per-file diffs behind it,
 * and the both-sides contents context expansion reads. The card numbers and
 * the diffs agree by construction, the way they agree in the real app because
 * both come from git.
 */

export const mockupTurnFiles: CheckpointRangeFile[] = [
  { path: "apps/desktop/src/lib/agentStore.ts", kind: "modified", additions: 11, deletions: 2 },
  { path: "apps/desktop/src/hooks/useAgentChat.ts", kind: "modified", additions: 2, deletions: 2 },
  { path: "apps/desktop/src/lib/agentStore.test.ts", kind: "added", additions: 8, deletions: 0 },
  { path: "apps/desktop/src/lib/publishers.ts", kind: "deleted", additions: 0, deletions: 6 },
];

const AGENT_STORE_DIFF = [
  "diff --git a/apps/desktop/src/lib/agentStore.ts b/apps/desktop/src/lib/agentStore.ts",
  "index 5f1c2ab..83bd910 100644",
  "--- a/apps/desktop/src/lib/agentStore.ts",
  "+++ b/apps/desktop/src/lib/agentStore.ts",
  "@@ -41,6 +41,13 @@ export const useAgentStore = create<AgentStore>()((set) => ({",
  "   registerTranscript: (id, read) =>",
  "     set((s) => ({",
  "       ...s,",
  "       transcripts: { ...s.transcripts, [id]: read },",
  "-      paint: { tokens: 0, at: 0 },",
  "+      // Token paints used to hit the store directly, re-rendering",
  "+      // every subscriber per token. They land in a ref instead and",
  "+      // flush once per animation frame.",
  "+      tokenRef: { text: \"\", dirty: false },",
  "+      scheduleFrame: (id: string) => {",
  "+        if (typeof requestAnimationFrame !== \"function\") return;",
  "+        requestAnimationFrame(() => flushTokenPaint(id));",
  "+      },",
  "     })),",
  "@@ -87,3 +93,5 @@ export const publishDraftToken = (id: string, text: string) => {",
  " export const publishDraftToken = (id: string, text: string) => {",
  "-  useAgentStore.setState((s) => ({ ...s, paint: { at: Date.now() } }));",
  "+  const store = useAgentStore.getState();",
  "+  store.tokenRef.text += text;",
  "+  store.scheduleFrame(id);",
  " };",
].join("\n");

const USE_AGENT_CHAT_DIFF = [
  "diff --git a/apps/desktop/src/hooks/useAgentChat.ts b/apps/desktop/src/hooks/useAgentChat.ts",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/apps/desktop/src/hooks/useAgentChat.ts",
  "+++ b/apps/desktop/src/hooks/useAgentChat.ts",
  "@@ -562,5 +562,5 @@",
  "   // Mirror for reads inside callbacks (rewind) without stale closures or making",
  "   // the callback re-created — and thus the composer re-rendered — every token.",
  "   const messagesRef = useRef<ChatMessage[]>(messages);",
  "-  const paintRef = useRef<number>(0);",
  "+  const paintRef = useRef<string>(\"\");",
  "   messagesRef.current = messages;",
  "@@ -1041,1 +1041,1 @@",
  "-  schedulePaint(id, paintRef.current + 1);",
  "+  schedulePaint(id, (paintRef.current + text).slice(-2000));",
].join("\n");

const TEST_FILE_DIFF = [
  "diff --git a/apps/desktop/src/lib/agentStore.test.ts b/apps/desktop/src/lib/agentStore.test.ts",
  "new file mode 100644",
  "index 0000000..91af3c2",
  "--- /dev/null",
  "+++ b/apps/desktop/src/lib/agentStore.test.ts",
  "@@ -0,0 +1,8 @@",
  "+import { describe, expect, it } from \"vitest\";",
  "+import { useAgentStore } from \"@/lib/agentStore\";",
  "+",
  "+describe(\"token paint batching\", () => {",
  "+  it(\"keeps the ref dirty until the frame flushes\", () => {",
  "+    expect(useAgentStore.getState().tokenRef.dirty).toBe(false);",
  "+  });",
  "+});",
].join("\n");

const PUBLISHERS_DIFF = [
  "diff --git a/apps/desktop/src/lib/publishers.ts b/apps/desktop/src/lib/publishers.ts",
  "deleted file mode 100644",
  "index 77c0d1e..0000000",
  "--- a/apps/desktop/src/lib/publishers.ts",
  "+++ /dev/null",
  "@@ -1,6 +0,0 @@",
  "-// The per-token publish path. Superseded by the ref + frame flush in",
  "-// agentStore; kept here only until the last caller moved over.",
  "-import { useAgentStore } from \"@/lib/agentStore\";",
  "-",
  "-export const publishToken = (id: string, text: string) =>",
  "-  useAgentStore.setState((s) => ({ ...s, paint: { at: Date.now() } }));",
].join("\n");

const mockupDiffs: Record<string, string> = {
  "apps/desktop/src/lib/agentStore.ts": AGENT_STORE_DIFF,
  "apps/desktop/src/hooks/useAgentChat.ts": USE_AGENT_CHAT_DIFF,
  "apps/desktop/src/lib/agentStore.test.ts": TEST_FILE_DIFF,
  "apps/desktop/src/lib/publishers.ts": PUBLISHERS_DIFF,
};

/** The review tab's per-file patch. Files outside the canned turn get the
 *  first one re-headed — close enough for a shape demo, and unreachable
 *  through the UI, whose file list comes from `mockupTurnFiles`. */
export const mockupTurnDiff = (file: string): string =>
  mockupDiffs[file] ?? mockupDiffs["apps/desktop/src/lib/agentStore.ts"];

/** The whole canned turn as one multi-file patch — what the review surface
 *  renders in a single scroll. Ordered like `mockupTurnFiles`, so the tree and
 *  the scroll agree. */
export const mockupTurnPatch = (): string =>
  mockupTurnFiles
    .map((file) => mockupDiffs[file.path])
    .filter(Boolean)
    .join("\n") + "\n";

const AGENT_STORE_OLD = [
  "import { create } from \"zustand\";",
  "",
  "export const useAgentStore = create<AgentStore>()((set) => ({",
  "  transcripts: {},",
  "  registerTranscript: (id, read) =>",
  "    set((s) => ({",
  "      ...s,",
  "      transcripts: { ...s.transcripts, [id]: read },",
  "      paint: { tokens: 0, at: 0 },",
  "    })),",
  "});",
  "",
  "export const publishDraftToken = (id: string, text: string) => {",
  "  useAgentStore.setState((s) => ({ ...s, paint: { at: Date.now() } }));",
  "};",
].join("\n");

const AGENT_STORE_NEW = [
  "import { create } from \"zustand\";",
  "",
  "export const useAgentStore = create<AgentStore>()((set) => ({",
  "  transcripts: {},",
  "  registerTranscript: (id, read) =>",
  "    set((s) => ({",
  "      ...s,",
  "      transcripts: { ...s.transcripts, [id]: read },",
  "      // Token paints used to hit the store directly, re-rendering",
  "      // every subscriber per token. They land in a ref instead and",
  "      // flush once per animation frame.",
  "      tokenRef: { text: \"\", dirty: false },",
  "      scheduleFrame: (id: string) => {",
  "        if (typeof requestAnimationFrame !== \"function\") return;",
  "        requestAnimationFrame(() => flushTokenPaint(id));",
  "      },",
  "    })),",
  "});",
  "",
  "export const publishDraftToken = (id: string, text: string) => {",
  "  const store = useAgentStore.getState();",
  "  store.tokenRef.text += text;",
  "  store.scheduleFrame(id);",
  "};",
].join("\n");

const USE_AGENT_CHAT_OLD = [
  "  // Mirror for reads inside callbacks (rewind) without stale closures or making",
  "  // the callback re-created — and thus the composer re-rendered — every token.",
  "  const messagesRef = useRef<ChatMessage[]>(messages);",
  "  const paintRef = useRef<number>(0);",
  "  messagesRef.current = messages;",
].join("\n");

const USE_AGENT_CHAT_NEW = [
  "  // Mirror for reads inside callbacks (rewind) without stale closures or making",
  "  // the callback re-created — and thus the composer re-rendered — every token.",
  "  const messagesRef = useRef<ChatMessage[]>(messages);",
  "  const paintRef = useRef<string>(\"\");",
  "  messagesRef.current = messages;",
].join("\n");

const mockupContents: Record<string, CheckpointRangeContents> = {
  "apps/desktop/src/lib/agentStore.ts": {
    oldText: AGENT_STORE_OLD,
    newText: AGENT_STORE_NEW,
  },
  "apps/desktop/src/hooks/useAgentChat.ts": {
    oldText: USE_AGENT_CHAT_OLD,
    newText: USE_AGENT_CHAT_NEW,
  },
  "apps/desktop/src/lib/agentStore.test.ts": {
    oldText: null,
    newText: TEST_FILE_DIFF.split("\n").slice(6).map((l) => l.slice(1)).join("\n"),
  },
  "apps/desktop/src/lib/publishers.ts": {
    oldText: PUBLISHERS_DIFF.split("\n").slice(6).map((l) => l.slice(1)).join("\n"),
    newText: null,
  },
};

/** Full both-sides contents for context expansion, keyed like the diffs. */
export const mockupTurnContents = (file: string): CheckpointRangeContents =>
  mockupContents[file] ?? { oldText: null, newText: null };

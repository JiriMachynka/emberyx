// A fake `claude` CLI: just enough of `claude -p --input-format stream-json
// --output-format stream-json` for one turn, plus the one-shot `-p <prompt>`
// call the app uses to title a thread and `--version` for provider probes.
// No network, no model. Every invocation is appended to $EMBERYX_E2E_ROOT/
// stub.log so a spec can see what the app launched and with which HOME.
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const record = (entry) => {
  const root = process.env.EMBERYX_E2E_ROOT;
  if (!root) return;
  try {
    appendFileSync(`${root}/stub.log`, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
  } catch {
    // The sandbox is removed at teardown; a straggler must not crash on it.
  }
};

record({ argv, home: process.env.HOME, cwd: process.cwd() });

if (argv.includes("--version")) {
  process.stdout.write("2.1.999 (Claude Code e2e stub)\n");
  process.exit(0);
}

// One-shot text call (thread titles, commit drafts): `-p <prompt> --output-format text`.
if (flag("--output-format") === "text") {
  process.stdout.write("E2E stub thread\n");
  process.exit(0);
}

const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
const model = "claude-e2e-stub";
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const event = (ev) =>
  emit({ type: "stream_event", event: ev, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID() });

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
};

let initialized = false;
let turn = 0;

const respond = (prompt) => {
  if (!initialized) {
    initialized = true;
    emit({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      cwd: process.cwd(),
      model,
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      permissionMode: "bypassPermissions",
      apiKeySource: "none",
      uuid: randomUUID(),
    });
  }
  turn += 1;
  const id = `msg_e2e_${turn}`;
  const reply = `Stub reply to: ${prompt.trim()}`;
  const usage = { input_tokens: 3, output_tokens: 7 };
  event({
    type: "message_start",
    message: { id, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 3, output_tokens: 1 } },
  });
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
  event({ type: "content_block_stop", index: 0 });
  event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
  event({ type: "message_stop" });
  emit({
    type: "assistant",
    message: { id, type: "message", role: "assistant", model, content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 0,
    num_turns: turn,
    result: reply,
    session_id: sessionId,
    total_cost_usd: 0,
    usage,
    uuid: randomUUID(),
  });
};

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "control_request") {
    emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type === "user") {
    record({ prompt: textOf(msg.message?.content) });
    respond(textOf(msg.message?.content));
  }
});
// The app closed our stdin (kill, quit, or its own death): nothing left to answer.
lines.on("close", () => process.exit(0));

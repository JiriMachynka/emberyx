import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `codex app-server` is flagged experimental and has renamed core methods
// before. This compares what the installed binary declares against what
// Emberyx sends, handles and answers, so a rename shows up here instead of as
// a turn that never settles. Run it after upgrading codex: `bun run codex:check`.

const DESKTOP = "apps/desktop";
const CODEX_RS = `${DESKTOP}/src-tauri/src/codex.rs`;
const ADAPTER = `${DESKTOP}/src/lib/codex/adapter.ts`;

// Methods Emberyx names that the binary is allowed not to declare.
const KNOWN_EXTRA: Record<string, string> = {
  "turn/failed":
    "defensive only — failure arrives as turn/completed with status \"failed\"",
};

// Server→client requests Emberyx deliberately leaves to the error reply,
// because each needs a capability the client never advertises.
const KNOWN_UNHANDLED: Record<string, string> = {
  "item/tool/call": "dynamic client tools are not advertised",
  "account/chatgptAuthTokens/refresh": "external auth tokens are not advertised",
  "attestation/generate": "attestation is not advertised",
  applyPatchApproval: "v1 approval, superseded by item/fileChange/requestApproval",
  execCommandApproval:
    "v1 approval, superseded by item/commandExecution/requestApproval",
};

const METHOD = /^[a-z][a-zA-Z]*(\/[a-zA-Z]+)+$/;

const run = (cmd: string[]) => {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed:\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
};

const declaredIn = (dir: string, file: string) =>
  new Set(
    [...readFileSync(join(dir, `${file}.ts`), "utf8").matchAll(/"method": "([^"]+)"/g)].map(
      (m) => m[1],
    ),
  );

const quotedMethods = (text: string) =>
  [...text.matchAll(/"([^"\s]+)"/g)].map((m) => m[1]).filter((s) => METHOD.test(s));

const arrayOf = (text: string, name: string) => {
  const body = text.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))?.[1];
  if (body === undefined) throw new Error(`${name} not found in ${ADAPTER}`);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

const tested = readFileSync(CODEX_RS, "utf8").match(
  /pub const TESTED_VERSION: &str = "([^"]+)"/,
)?.[1];
const installed = run(["codex", "--version"]).trim().split(/\s+/).pop();

const out = mkdtempSync(join(tmpdir(), "codex-ts-"));
let failed = false;
try {
  run(["codex", "app-server", "generate-ts", "--out", out]);
  const clientRequests = declaredIn(out, "ClientRequest");
  const serverRequests = declaredIn(out, "ServerRequest");
  const notifications = declaredIn(out, "ServerNotification");
  const declared = new Set([...clientRequests, ...serverRequests, ...notifications]);

  // Every file that speaks to app-server: the Codex modules, the chat hook,
  // the Rust client, and anything else invoking `codex_request`.
  const sources = [
    CODEX_RS,
    ...readdirSync(`${DESKTOP}/src/lib/codex`)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `${DESKTOP}/src/lib/codex/${f}`),
    ...run(["git", "grep", "-l", "codex_request", "--", `${DESKTOP}/src`])
      .split("\n")
      .filter((f) => f && !f.includes(".test.")),
  ];
  const used = new Set(sources.flatMap((f) => quotedMethods(readFileSync(f, "utf8"))));

  // Only names in app-server's own namespaces; ACP and hook names share the
  // same slash shape but are not Codex's to declare.
  const namespaces = new Set([...declared].map((m) => m.split("/")[0]));
  const missing = [...used]
    .filter((m) => namespaces.has(m.split("/")[0]) && !declared.has(m) && !(m in KNOWN_EXTRA))
    .sort();

  const adapter = readFileSync(ADAPTER, "utf8");
  const handled = new Set([...arrayOf(adapter, "APPROVAL_METHODS"), ...arrayOf(adapter, "ASK_METHODS")]);
  const unhandled = [...serverRequests]
    .filter((m) => !handled.has(m) && !(m in KNOWN_UNHANDLED))
    .sort();

  console.log(`codex installed ${installed}, Emberyx tested against ${tested}`);
  if (installed !== tested) {
    console.log("  versions differ — protocol.ts and TESTED_VERSION may need a refresh");
  }
  if (missing.length > 0) {
    failed = true;
    console.log(`\nUsed by Emberyx, not declared by codex ${installed}:`);
    for (const m of missing) console.log(`  ${m}`);
  }
  if (unhandled.length > 0) {
    failed = true;
    console.log(`\nServer→client requests Emberyx does not handle (they get an error reply):`);
    for (const m of unhandled) console.log(`  ${m}`);
  }
  if (!failed) console.log("\nEvery method Emberyx uses is declared, every server request is accounted for.");
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

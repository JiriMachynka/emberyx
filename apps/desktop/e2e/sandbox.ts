/**
 * The throwaway world the app under test runs in. Everything the app could
 * read or write — AppData, ~/.claude, ~/.codex, WebKit's localStorage, the
 * login-shell env cache, the daemon socket, scratch files — resolves inside
 * one temp directory, and the only `claude` it can reach is the stub.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { e2eDir } from "./paths";

export const stubScript = join(e2eDir, "fixtures", "claude.mjs");

export interface Sandbox {
  root: string;
  home: string;
  tmp: string;
  bin: string;
  project: string;
  stubLog: string;
}

export const sandboxAt = (root: string): Sandbox => ({
  root,
  home: join(root, "home"),
  tmp: join(root, "tmp"),
  bin: join(root, "bin"),
  project: join(root, "e2e-project"),
  stubLog: join(root, "stub.log"),
});

/** Env for the app process. Merged over the launcher's own env, which
 *  `scrubHostEnv` has already stripped of anything that points at real state. */
export const appEnv = (s: Sandbox): Record<string, string> => ({
  HOME: s.home,
  // WebKit resolves its data store through NSHomeDirectory(), which ignores
  // $HOME but honours this. Without it localStorage lands in the developer's
  // real ~/Library/WebKit/emberyx — the same store `tauri dev` uses.
  CFFIXED_USER_HOME: s.home,
  ZDOTDIR: s.home,
  TMPDIR: `${s.tmp}/`,
  SHELL: "/bin/zsh",
  PATH: `${s.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
  XDG_CONFIG_HOME: join(s.home, ".config"),
  XDG_DATA_HOME: join(s.home, ".local/share"),
  XDG_CACHE_HOME: join(s.home, ".cache"),
  CLAUDE_CONFIG_DIR: join(s.home, ".claude"),
  CODEX_HOME: join(s.home, ".codex"),
  EMBERYX_DAEMON_SOCKET: join(s.root, "emberyxd.sock"),
  EMBERYX_DAEMON_STATE: join(s.root, "emberyxd.json"),
  EMBERYX_E2E_ROOT: s.root,
});

/** Drop host variables that would point the app (or the agents it spawns) at
 *  real state or real credentials. `@wdio/tauri-service` spawns the app with
 *  `{ ...process.env, ...env }`, so a variable has to leave process.env itself. */
export const scrubHostEnv = () => {
  const leaky = /^(CLAUDE|CODEX|ANTHROPIC|OPENAI|OPENROUTER|GROK|XAI|GEMINI|EMBERYX_|XDG_|ZDOTDIR$)/;
  for (const key of Object.keys(process.env)) {
    if (leaky.test(key) && !key.startsWith("EMBERYX_E2E_")) delete process.env[key];
  }
};

const git = (cwd: string, s: Sandbox, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    // The developer's global git config (signing, hooks) must not reach this repo.
    env: { ...process.env, HOME: s.home, GIT_CONFIG_NOSYSTEM: "1" },
  });

export const createSandbox = (): Sandbox => {
  const s = sandboxAt(realpathSync(mkdtempSync(join(tmpdir(), "emberyx-e2e-"))));
  for (const dir of [s.home, s.tmp, s.bin, s.project]) mkdirSync(dir, { recursive: true });

  // /etc/zprofile's path_helper puts the system dirs first when the app
  // captures its login-shell env; this runs after it, so the stub stays first.
  writeFileSync(join(s.home, ".zshrc"), `export PATH="${s.bin}:$PATH"\n`);

  const stub = join(s.bin, "claude");
  writeFileSync(
    stub,
    `#!/bin/sh\nexec "${process.execPath}" "${stubScript}" "$@"\n`
  );
  chmodSync(stub, 0o755);

  writeFileSync(join(s.project, "README.md"), "# e2e project\n");
  git(s.project, s, "init", "-q", "-b", "main");
  git(s.project, s, "add", "-A");
  git(
    s.project,
    s,
    "-c",
    "user.name=Emberyx E2E",
    "-c",
    "user.email=e2e@emberyx.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init"
  );
  return s;
};

/**
 * Builds the binary the E2E suite drives: debug, `--features e2e` (the embedded
 * WebDriver server), no bundle. The frontend is embedded, so no dev server.
 *
 * `beforeBuildCommand` is narrowed to `vite build`: the `tsc` gate belongs to
 * CI's typecheck job, and an E2E build that refuses to start over a type error
 * in a test file is not telling you anything about the app.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appBinary, desktopDir, tauriDir } from "./paths";

const run = (cmd: string, args: string[]) => {
  const res = spawnSync(cmd, args, { cwd: desktopDir, stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" })
  .stdout.split("\n")
  .find((l) => l.startsWith("host: "))
  ?.slice("host: ".length)
  .trim();
if (!host) throw new Error("could not read the host triple from `rustc -vV`");

// tauri-build refuses to compile while a declared externalBin is missing. The
// suite never starts the daemon (persistent agents stay off), so a placeholder
// is enough — and an existing real daemon is left alone.
if (!existsSync(join(tauriDir, "binaries", `emberyxd-${host}`))) {
  run("bun", ["run", "sidecar", "--", "--stub", "--target", host]);
}

run("bun", [
  "run",
  "tauri",
  "build",
  "--debug",
  "--no-bundle",
  "--features",
  "e2e",
  "--config",
  JSON.stringify({ build: { beforeBuildCommand: "bunx vite build" } }),
]);

console.log(`e2e binary → ${appBinary}`);

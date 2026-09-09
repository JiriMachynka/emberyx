/**
 * Files `emberyxd` where Tauri's `externalBin` expects it:
 * `src-tauri/binaries/emberyxd-<target-triple>`.
 *
 * The suffix is not decoration — Tauri resolves a sidecar by appending the
 * triple and strips it again when bundling, so the binary lands in the .app as
 * `Contents/MacOS/emberyxd`, which is the path `Daemon::ensure` probes. A build
 * without this file fails at bundle time rather than at runtime, which is the
 * good direction for a missing daemon to fail in.
 *
 * `tauri build` already passes `--bins`, so it compiles emberyxd in the same
 * cargo invocation as the app. `--stub` satisfies tauri-build before that
 * compile; `--copy` (from `beforeBundleCommand`) overwrites the stub with the
 * real binary. A separate `cargo build --bin emberyxd` is a different
 * fingerprint and is not what release CI should run.
 *
 * `--target` is optional; without it `TAURI_ENV_TARGET_TRIPLE` (set on Tauri
 * hooks) or the host triple from `rustc -vV` is used.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "apps/desktop/src-tauri");

const run = (cmd: string, args: string[]) => {
  const res = spawnSync(cmd, args, { cwd: tauriDir, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status ?? "a signal"}`);
  }
};

const hostTriple = () => {
  const res = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = res.stdout?.split("\n").find((l) => l.startsWith("host: "));
  if (!line) throw new Error("could not read the host triple from `rustc -vV`");
  return line.slice("host: ".length).trim();
};

const flagIndex = process.argv.indexOf("--target");
const target =
  flagIndex === -1
    ? (process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple())
    : process.argv[flagIndex + 1];
if (!target) throw new Error("--target was given without a triple");

const binaries = join(tauriDir, "binaries");
const sidecar = join(binaries, `emberyxd-${target}`);

/**
 * `tauri-build` refuses to run while a declared `externalBin` is missing, and
 * that applies to *every* cargo invocation — `cargo test` and `cargo clippy`
 * included, neither of which bundles anything. So the placeholder is not just a
 * bootstrap trick for this script; it is what lets the crate be compiled at all
 * before a daemon exists.
 *
 * It is a script that fails loudly rather than an empty file. If one ever does
 * reach a bundle, persistent mode reports a daemon that refuses to start, which
 * is findable — an empty file would be spawned, do nothing, and look like a
 * daemon that started and went quiet.
 */
const writePlaceholder = () => {
  mkdirSync(binaries, { recursive: true });
  writeFileSync(
    sidecar,
    "#!/bin/sh\necho 'emberyxd placeholder: this build never compiled the daemon' >&2\nexit 1\n",
    { mode: 0o755 },
  );
};

const profile = process.env.TAURI_ENV_DEBUG === "true" ? "debug" : "release";

const copyBuilt = () => {
  const primary = join(tauriDir, "target", target, profile, "emberyxd");
  let built = existsSync(primary) ? primary : undefined;
  // `tauri build` without `--target` writes to target/release/, even though
  // the dest name is still the host triple. Don't fall back for a foreign
  // triple — that would copy the host daemon under the wrong sidecar name.
  const hostFallback = join(tauriDir, "target", profile, "emberyxd");
  if (!built && target === hostTriple() && existsSync(hostFallback)) {
    built = hostFallback;
  }
  if (!built) {
    throw new Error(
      `emberyxd was not compiled (looked in ${primary}). \`tauri build\` passes --bins; run that before --copy.`,
    );
  }
  mkdirSync(binaries, { recursive: true });
  copyFileSync(built, sidecar);
  console.log(`emberyxd → binaries/emberyxd-${target}`);
};

if (process.argv.includes("--stub") && process.argv.includes("--copy")) {
  throw new Error("--stub and --copy cannot be combined");
}

if (process.argv.includes("--stub")) {
  writePlaceholder();
  console.log(`placeholder → binaries/emberyxd-${target} (not a daemon)`);
} else if (process.argv.includes("--copy")) {
  copyBuilt();
} else {
  if (!existsSync(sidecar)) writePlaceholder();
  run("cargo", ["build", "--release", "--bin", "emberyxd", "--target", target]);
  copyBuilt();
}

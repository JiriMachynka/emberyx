import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const e2eDir = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(e2eDir, "..");
export const tauriDir = join(desktopDir, "src-tauri");

/** The debug binary `e2e:build` produces. Follows CARGO_TARGET_DIR the same
 *  way cargo does, so a build into a shared target dir is found without a flag. */
export const appBinary =
  process.env.EMBERYX_E2E_BINARY ??
  join(resolve(process.env.CARGO_TARGET_DIR ?? join(tauriDir, "target")), "debug", "emberyx");

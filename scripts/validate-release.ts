import { readFileSync } from "node:fs";

const tag = process.argv[2];
const version = tag?.startsWith("v") ? tag.slice(1) : undefined;

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Release tag must be a semver tag such as v0.2.6, got ${tag ?? "nothing"}`);
}

const packageVersion = JSON.parse(
  readFileSync("apps/desktop/package.json", "utf8"),
).version;
const cargoVersion = readFileSync("apps/desktop/src-tauri/Cargo.toml", "utf8").match(
  /\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/,
)?.[1];
const tauriVersion = JSON.parse(
  readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"),
).version;

const versions = { packageVersion, cargoVersion, tauriVersion };
const mismatches = Object.entries(versions).filter(([, value]) => value !== version);

if (mismatches.length > 0) {
  throw new Error(
    `Tag ${tag} does not match project versions: ${JSON.stringify(versions)}`,
  );
}

console.log(`Release ${tag} matches all project versions.`);

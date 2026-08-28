import { readFileSync } from "node:fs";

// With a tag, this is the release gate: all three manifests must equal the tag.
// Without one, it is the CI drift check: they only have to agree with each other.
const tag = process.argv[2];

if (tag !== undefined && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag must be a semver tag such as v0.2.6, got ${tag}`);
}

const versions = {
  "apps/desktop/package.json": JSON.parse(
    readFileSync("apps/desktop/package.json", "utf8"),
  ).version,
  "apps/desktop/src-tauri/Cargo.toml": readFileSync(
    "apps/desktop/src-tauri/Cargo.toml",
    "utf8",
  ).match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1],
  "apps/desktop/src-tauri/tauri.conf.json": JSON.parse(
    readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"),
  ).version,
};

const listed = Object.entries(versions)
  .map(([file, value]) => `  ${file}: ${value ?? "not found"}`)
  .join("\n");

const missing = Object.entries(versions).filter(([, value]) => !value);

if (missing.length > 0) {
  throw new Error(`Could not read a version from every manifest:\n${listed}`);
}

if (tag === undefined) {
  const distinct = new Set(Object.values(versions));

  if (distinct.size > 1) {
    throw new Error(`Project versions disagree:\n${listed}`);
  }

  console.log(`All project versions are ${[...distinct][0]}.`);
} else {
  const version = tag.slice(1);
  const mismatches = Object.values(versions).filter((value) => value !== version);

  if (mismatches.length > 0) {
    throw new Error(`Tag ${tag} does not match project versions:\n${listed}`);
  }

  console.log(`Release ${tag} matches all project versions.`);
}

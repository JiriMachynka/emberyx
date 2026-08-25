import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: bun run release <version> (for example, 0.2.6)");
  process.exit(1);
}

const files = [
  {
    path: "apps/desktop/package.json",
    pattern: /("version"\s*:\s*)"[^"]+"/,
  },
  {
    path: "apps/desktop/src-tauri/Cargo.toml",
    pattern: /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/,
  },
  {
    path: "apps/desktop/src-tauri/tauri.conf.json",
    pattern: /("version"\s*:\s*)"[^"]+"/,
  },
];

for (const file of files) {
  const content = readFileSync(file.path, "utf8");
  const updated = content.replace(file.pattern, `$1"${version}"`);

  if (updated === content) {
    throw new Error(`Could not find a version in ${file.path}`);
  }

  writeFileSync(file.path, updated);
}

console.log(`Updated Emberyx to ${version} in ${files.length} files.`);

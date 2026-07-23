import {
  Braces,
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Palette,
  type LucideIcon,
} from "lucide-react";

/** Icon + accent color for a file, by extension. */
interface FileIcon {
  Icon: LucideIcon;
  className: string;
}

const CODE = (className: string): FileIcon => ({ Icon: FileCode, className });

const BY_EXT: Record<string, FileIcon> = {
  ts: CODE("text-blue-400"),
  tsx: CODE("text-blue-400"),
  mts: CODE("text-blue-400"),
  cts: CODE("text-blue-400"),
  js: CODE("text-yellow-400"),
  jsx: CODE("text-yellow-400"),
  mjs: CODE("text-yellow-400"),
  cjs: CODE("text-yellow-400"),
  rs: CODE("text-orange-400"),
  py: CODE("text-sky-400"),
  go: CODE("text-cyan-400"),
  rb: CODE("text-red-400"),
  php: CODE("text-indigo-400"),
  java: CODE("text-red-400"),
  kt: CODE("text-violet-400"),
  swift: CODE("text-orange-400"),
  c: CODE("text-blue-300"),
  h: CODE("text-blue-300"),
  cpp: CODE("text-blue-300"),
  hpp: CODE("text-blue-300"),
  vue: CODE("text-emerald-400"),
  svelte: CODE("text-orange-400"),
  html: CODE("text-orange-400"),
  xml: CODE("text-orange-300"),

  json: { Icon: Braces, className: "text-amber-400" },
  jsonc: { Icon: Braces, className: "text-amber-400" },

  css: { Icon: Palette, className: "text-sky-300" },
  scss: { Icon: Palette, className: "text-pink-400" },
  less: { Icon: Palette, className: "text-sky-300" },

  md: { Icon: FileText, className: "text-slate-300" },
  mdx: { Icon: FileText, className: "text-slate-300" },
  markdown: { Icon: FileText, className: "text-slate-300" },
  txt: { Icon: FileText, className: "text-muted-foreground" },

  sh: { Icon: FileTerminal, className: "text-emerald-400" },
  bash: { Icon: FileTerminal, className: "text-emerald-400" },
  zsh: { Icon: FileTerminal, className: "text-emerald-400" },
  fish: { Icon: FileTerminal, className: "text-emerald-400" },

  yml: { Icon: FileCog, className: "text-violet-400" },
  yaml: { Icon: FileCog, className: "text-violet-400" },
  toml: { Icon: FileCog, className: "text-violet-400" },
  ini: { Icon: FileCog, className: "text-violet-400" },
  env: { Icon: FileCog, className: "text-yellow-300" },

  sql: { Icon: Database, className: "text-teal-400" },
  db: { Icon: Database, className: "text-teal-400" },
  sqlite: { Icon: Database, className: "text-teal-400" },

  svg: { Icon: FileImage, className: "text-pink-400" },
  png: { Icon: FileImage, className: "text-pink-400" },
  jpg: { Icon: FileImage, className: "text-pink-400" },
  jpeg: { Icon: FileImage, className: "text-pink-400" },
  gif: { Icon: FileImage, className: "text-pink-400" },
  webp: { Icon: FileImage, className: "text-pink-400" },
  avif: { Icon: FileImage, className: "text-pink-400" },
  ico: { Icon: FileImage, className: "text-pink-400" },

  csv: { Icon: FileSpreadsheet, className: "text-green-400" },
  tsv: { Icon: FileSpreadsheet, className: "text-green-400" },
  xlsx: { Icon: FileSpreadsheet, className: "text-green-400" },

  zip: { Icon: FileArchive, className: "text-amber-300" },
  gz: { Icon: FileArchive, className: "text-amber-300" },
  tgz: { Icon: FileArchive, className: "text-amber-300" },
  tar: { Icon: FileArchive, className: "text-amber-300" },

  lock: { Icon: FileLock, className: "text-muted-foreground" },
};

/** Whole-name matches that beat the extension (dotfiles, lockfiles). */
const BY_NAME: Record<string, FileIcon> = {
  dockerfile: { Icon: FileCog, className: "text-sky-400" },
  ".gitignore": { Icon: FileCog, className: "text-muted-foreground" },
  ".dockerignore": { Icon: FileCog, className: "text-muted-foreground" },
  "bun.lock": { Icon: FileLock, className: "text-muted-foreground" },
  "bun.lockb": { Icon: FileLock, className: "text-muted-foreground" },
};

const FALLBACK: FileIcon = { Icon: File, className: "text-muted-foreground" };

/** Pick an icon + color for a file name (e.g. "App.tsx" → blue FileCode). */
export function fileIcon(name: string): FileIcon {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  // ".env.local" and "vite.config.ts" both resolve on their last segment.
  const ext = lower.includes(".") ? lower.split(".").pop()! : "";
  if (lower.startsWith(".env")) return BY_EXT.env;
  return BY_EXT[ext] ?? FALLBACK;
}

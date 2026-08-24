/**
 * Opening a project or a file in an external editor.
 *
 * Each editor gets two argument lists rather than one template with optional
 * placeholders: opening a project and opening a file at a position are
 * genuinely different invocations, and a single template would have to drop
 * flags mid-list when there is no file — leaving a dangling `--goto` behind.
 *
 * Placeholders are `{project}`, `{file}`, `{line}`, `{column}`. Arguments are
 * built as a list and executed directly, never through a shell, so a path with
 * spaces or quotes in it is data and not syntax.
 */

export type IdeId =
  | "vscode"
  | "cursor"
  | "zed"
  | "windsurf"
  | "intellij"
  | "webstorm"
  | "sublime"
  | "custom";

export interface Ide {
  id: IdeId;
  label: string;
  /** Executable looked up on PATH. */
  binary: string;
  /** Argv for "open this project". */
  projectArgs: string[];
  /** Argv for "open this file, at this position". */
  fileArgs: string[];
}

export const IDES: Ide[] = [
  {
    id: "vscode",
    label: "VS Code",
    binary: "code",
    projectArgs: ["{project}"],
    fileArgs: ["{project}", "--goto", "{file}:{line}:{column}"],
  },
  {
    id: "cursor",
    label: "Cursor",
    binary: "cursor",
    projectArgs: ["{project}"],
    fileArgs: ["{project}", "--goto", "{file}:{line}:{column}"],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    binary: "windsurf",
    projectArgs: ["{project}"],
    fileArgs: ["{project}", "--goto", "{file}:{line}:{column}"],
  },
  {
    id: "zed",
    label: "Zed",
    binary: "zed",
    projectArgs: ["{project}"],
    fileArgs: ["{project}", "{file}:{line}:{column}"],
  },
  {
    id: "intellij",
    label: "IntelliJ IDEA",
    binary: "idea",
    projectArgs: ["{project}"],
    fileArgs: ["--line", "{line}", "--column", "{column}", "{file}"],
  },
  {
    id: "webstorm",
    label: "WebStorm",
    binary: "webstorm",
    projectArgs: ["{project}"],
    fileArgs: ["--line", "{line}", "--column", "{column}", "{file}"],
  },
  {
    id: "sublime",
    label: "Sublime Text",
    binary: "subl",
    projectArgs: ["{project}"],
    fileArgs: ["{project}", "{file}:{line}:{column}"],
  },
];

export const IDE_LABEL: Record<IdeId, string> = {
  ...Object.fromEntries(IDES.map((ide) => [ide.id, ide.label])),
  custom: "Custom",
} as Record<IdeId, string>;

export interface IdeTarget {
  project: string;
  file?: string;
  /** 1-based, like every editor's own CLI. */
  line?: number;
  column?: number;
}

export interface IdeCommand {
  program: string;
  args: string[];
  cwd: string;
}

/**
 * Split a custom command the way a shell would, minus the shell: whitespace
 * separates arguments, and single or double quotes group them. Enough for a
 * command line someone typed into a settings field, and it never executes
 * anything it did not split itself.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/** The project targets ES2020, so no `String.replaceAll`. */
const replaceAll = (text: string, token: string, value: string): string =>
  text.split(token).join(value);

const substitute = (arg: string, target: IdeTarget): string => {
  let out = replaceAll(arg, "{project}", target.project);
  out = replaceAll(out, "{file}", target.file ?? "");
  out = replaceAll(out, "{line}", String(target.line ?? 1));
  return replaceAll(out, "{column}", String(target.column ?? 1));
};

/**
 * Build the command for a target. Returns null when the choice can't produce
 * one — a custom entry with nothing in it — so the caller reports that instead
 * of launching an empty program name.
 */
export function buildIdeCommand(
  id: IdeId,
  target: IdeTarget,
  customCommand = ""
): IdeCommand | null {
  if (id === "custom") {
    const tokens = tokenize(customCommand).map((token) => substitute(token, target));
    const [program, ...args] = tokens;
    return program ? { program, args, cwd: target.project } : null;
  }
  const ide = IDES.find((candidate) => candidate.id === id);
  if (!ide) return null;
  const template = target.file ? ide.fileArgs : ide.projectArgs;
  return {
    program: ide.binary,
    args: template.map((arg) => substitute(arg, target)),
    cwd: target.project,
  };
}

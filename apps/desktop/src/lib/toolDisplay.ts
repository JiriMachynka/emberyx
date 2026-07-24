import { langFromPath } from "./highlight";

export type ToolIcon =
  | "task"
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "search"
  | "globe"
  | "list"
  | "plan"
  | "mcp"
  | "tool";

export interface FieldRow {
  key: string;
  value: string;
}

export interface TodoItem {
  status: "completed" | "in_progress" | "pending";
  text: string;
}

/** A chunk of a tool's expanded input. The component renders per `kind`. */
export type ToolBodyPart =
  | { kind: "code"; label?: string; code: string; lang: string | null }
  | { kind: "text"; label?: string; text: string }
  | { kind: "diff"; label?: string; before: string; after: string; lang: string | null }
  | { kind: "fields"; rows: FieldRow[] }
  | { kind: "todos"; items: TodoItem[] };

export interface ToolDisplay {
  icon: ToolIcon;
  /** Short tool name, shown first in the header. */
  label: string;
  /** The one thing worth reading while collapsed — description, path, query. */
  title?: string;
  /** Secondary qualifier — agent type, line range, search path. */
  meta?: string;
  /** Expanded content. Empty means the header already said everything. */
  body: ToolBodyPart[];
  /** Render `title` in mono (paths, patterns, raw commands). */
  mono?: boolean;
}

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Trailing two path segments, enough to identify a file without the noise. */
export function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

/** "mcp__emberyx__ask_user" → { server: "emberyx", tool: "ask user" } */
function mcpParts(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return null;
  return {
    server: parts[1].replace(/_/g, " "),
    tool: parts.slice(2).join("__").replace(/_/g, " "),
  };
}

/** Argument keys worth promoting to the header title, most specific first. */
const TITLE_KEYS = [
  "query", "q", "pattern", "search", "question", "prompt",
  "url", "uri", "path", "file_path", "symbol", "name", "id",
  "command", "text", "message", "title",
];

const MONO_TITLE_KEYS = new Set(["url", "uri", "path", "file_path", "id", "command"]);

/** The one argument worth reading while collapsed — picked by priority so a
 *  bespoke-less tool still gets a meaningful headline instead of a bare name. */
function argTitle(i: Record<string, unknown>): {
  title?: string;
  key?: string;
  mono?: boolean;
} {
  for (const key of TITLE_KEYS) {
    const v = str(i[key]);
    if (v) return { title: v.replace(/\s+/g, " "), key, mono: MONO_TITLE_KEYS.has(key) };
  }
  return {};
}

function lineRange(i: Record<string, unknown>): string | undefined {
  const offset = num(i.offset);
  const limit = num(i.limit);
  if (offset == null && limit == null) return undefined;
  const start = offset ?? 1;
  return limit == null ? `from ${start}` : `${start}–${start + limit - 1}`;
}

const isLong = (s: string): boolean => s.length > 120 || s.includes("\n");

/**
 * Last-resort renderer: scalars become a key/value table, long strings become
 * prose, nested structures become labelled JSON. Beats one undifferentiated
 * JSON dump for tools we have no bespoke layout for.
 */
function genericBody(input: unknown, skip: string[] = []): ToolBodyPart[] {
  const rows: FieldRow[] = [];
  const parts: ToolBodyPart[] = [];
  for (const [key, value] of Object.entries(rec(input))) {
    if (value == null || skip.includes(key)) continue;
    if (typeof value === "string") {
      if (isLong(value)) parts.push({ kind: "text", label: key, text: value });
      else rows.push({ key, value });
    } else if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ key, value: String(value) });
    } else {
      parts.push({ kind: "code", label: key, code: JSON.stringify(value, null, 2), lang: "json" });
    }
  }
  return rows.length > 0 ? [{ kind: "fields", rows }, ...parts] : parts;
}

/** Map a tool call to header + body chunks. Pure; the component picks icons. */
export function describeTool(name: string, input: unknown): ToolDisplay {
  const i = rec(input);

  switch (name) {
    case "Task":
    case "Agent": {
      const prompt = str(i.prompt);
      return {
        icon: "task",
        label: "Agent",
        title: str(i.description),
        meta: str(i.subagent_type),
        body: [
          ...(prompt ? [{ kind: "text" as const, label: "Prompt", text: prompt }] : []),
          // run_in_background is routing, not content: it decides whether the
          // run gets a chip by the composer, so it never renders as a field.
          ...genericBody(input, [
            "prompt",
            "description",
            "subagent_type",
            "run_in_background",
          ]),
        ],
      };
    }

    case "Read": {
      const file = str(i.file_path);
      return {
        icon: "read",
        label: "Read",
        title: file ? shortPath(file) : undefined,
        meta: lineRange(i),
        mono: true,
        body: [],
      };
    }

    case "Write": {
      const file = str(i.file_path);
      const content = str(i.content);
      return {
        icon: "write",
        label: "Write",
        title: file ? shortPath(file) : undefined,
        mono: true,
        body: content ? [{ kind: "code", code: content, lang: file ? langFromPath(file) : null }] : [],
      };
    }

    case "Edit":
    case "MultiEdit": {
      const file = str(i.file_path);
      const lang = file ? langFromPath(file) : null;
      const edits = Array.isArray(i.edits) ? i.edits.map(rec) : [i];
      const multi = edits.length > 1;
      const body: ToolBodyPart[] = edits
        .filter((e) => str(e.old_string) != null || str(e.new_string) != null)
        .map((e, idx) => ({
          kind: "diff" as const,
          label: multi ? `Edit ${idx + 1}` : undefined,
          before: str(e.old_string) ?? "",
          after: str(e.new_string) ?? "",
          lang,
        }));
      return {
        icon: "edit",
        label: multi ? `Edit ×${edits.length}` : "Edit",
        title: file ? shortPath(file) : undefined,
        mono: true,
        body,
      };
    }

    case "NotebookEdit": {
      const file = str(i.notebook_path);
      const source = str(i.new_source);
      return {
        icon: "edit",
        label: "Notebook",
        title: file ? shortPath(file) : undefined,
        meta: str(i.edit_mode),
        mono: true,
        body: source ? [{ kind: "code", code: source, lang: "python" }] : [],
      };
    }

    case "Bash": {
      const command = str(i.command);
      const description = str(i.description);
      return {
        icon: "bash",
        label: "Bash",
        title: description ?? command,
        mono: description == null,
        body: [
          ...(command ? [{ kind: "code" as const, code: command, lang: "bash" }] : []),
          ...genericBody(input, ["command", "description"]),
        ],
      };
    }

    case "BashOutput":
    case "KillShell":
      return {
        icon: "bash",
        label: name === "KillShell" ? "Kill shell" : "Shell output",
        title: str(i.bash_id) ?? str(i.shell_id),
        mono: true,
        body: [],
      };

    case "Grep":
    case "Glob": {
      const path = str(i.path);
      const glob = str(i.glob);
      return {
        icon: "search",
        label: name,
        title: str(i.pattern),
        meta: [glob, path && shortPath(path)].filter(Boolean).join(" in ") || undefined,
        mono: true,
        body: genericBody(input, ["pattern", "path", "glob"]),
      };
    }

    case "WebFetch": {
      const prompt = str(i.prompt);
      return {
        icon: "globe",
        label: "WebFetch",
        title: str(i.url),
        mono: true,
        body: prompt ? [{ kind: "text", label: "Prompt", text: prompt }] : [],
      };
    }

    case "WebSearch":
      return { icon: "globe", label: "WebSearch", title: str(i.query), body: [] };

    case "ExitPlanMode": {
      const plan = str(i.plan);
      return {
        icon: "plan",
        label: "Plan",
        body: plan ? [{ kind: "text", text: plan }] : [],
      };
    }

    case "Skill":
      return {
        icon: "plan",
        label: "Skill",
        title: str(i.skill),
        meta: str(i.args),
        mono: true,
        body: [],
      };

    case "SlashCommand":
      return { icon: "plan", label: "Command", title: str(i.command), mono: true, body: [] };

    case "TodoWrite": {
      const items: TodoItem[] = (Array.isArray(i.todos) ? i.todos.map(rec) : []).map((t) => {
        const status = String(t.status);
        return {
          status:
            status === "completed" || status === "in_progress" ? status : "pending",
          text: str(t.content) ?? str(t.activeForm) ?? "",
        };
      });
      const done = items.filter((t) => t.status === "completed").length;
      return {
        icon: "list",
        label: "Todos",
        meta: items.length > 0 ? `${done}/${items.length}` : undefined,
        body: items.length > 0 ? [{ kind: "todos", items }] : [],
      };
    }

    case "AskUserQuestion": {
      const questions = Array.isArray(i.questions) ? i.questions.map(rec) : [];
      return {
        icon: "list",
        label: "Question",
        title: str(questions[0]?.question),
        meta: questions.length > 1 ? `${questions.length} questions` : undefined,
        body: genericBody(input),
      };
    }

    default: {
      const { title, key, mono } = argTitle(i);
      const skip = key ? [key] : [];
      const mcp = mcpParts(name);
      if (mcp) {
        return {
          icon: "mcp",
          label: mcp.tool,
          meta: mcp.server,
          title,
          mono,
          body: genericBody(input, skip),
        };
      }
      return { icon: "tool", label: name, title, mono, body: genericBody(input, skip) };
    }
  }
}

/** Drop harness-injected <system-reminder> blocks from displayed tool output
 *  (Claude still received them in-band — this is display-only noise removal). */
export const stripReminders = (text: string): string =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");

/** Pretty-print + tag as json when a tool result is JSON; else leave as-is.
 *  Content-block arrays (`[{type:"text",text}]`, how agent and MCP results
 *  arrive) are unwrapped to their text — the wrapper is pure noise. */
export const detectResult = (result: string): { code: string; lang: string | null } => {
  const trimmed = result.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const blocks = Array.isArray(parsed) ? parsed : null;
      if (
        blocks &&
        blocks.length > 0 &&
        blocks.every(
          (b): b is { type: string; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "text" &&
            typeof (b as { text?: unknown }).text === "string"
        )
      ) {
        return { code: blocks.map((b) => b.text).join("\n").trim(), lang: null };
      }
      return { code: JSON.stringify(parsed, null, 2), lang: "json" };
    } catch {
      // not valid JSON — fall through to plain text
    }
  }
  return { code: result, lang: null };
};

/** Turn a tool result into display chunks. A JSON *object* result becomes the
 *  same key/value / prose / nested-JSON layout as inputs — so MCP and tool
 *  results read as fields, not a raw blob. Everything else (plain text, file
 *  contents, JSON arrays / content-blocks) keeps its mono code rendering. */
export function describeResult(result: string): ToolBodyPart[] {
  const trimmed = result.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = genericBody(parsed);
        if (body.length > 0) return body;
      }
    } catch {
      // not an object — fall through
    }
  }
  const { code, lang } = detectResult(trimmed);
  return code ? [{ kind: "code", code, lang }] : [];
}

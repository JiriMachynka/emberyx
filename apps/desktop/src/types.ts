export interface PackageInfo {
  name: string;
  relPath: string;
  path: string;
  devCommand: string;
}

export interface WorkspaceInfo {
  kind: "turbo" | "pnpm" | "npm" | "single";
  packageManager: "bun" | "pnpm" | "yarn" | "npm";
  packages: PackageInfo[];
  allCommand: string | null;
}

/** A terminal session shown as a tab. */
export interface Session {
  id: string;
  projectId: string;
  label: string;
  cwd: string;
  command?: string;
  kind: "agent" | "dev" | "chat" | "dokploy-logs" | "editor";
  /** Stable key for cross-restart scrollback restore; only the project's
   *  primary agent sets it, so secondary/dev panes never share its log. */
  persistKey?: string;
  /** Claude session id to resume (chat kind only). */
  resume?: string;
  /** Service to stream logs for (dokploy-logs kind only). */
  dokployLog?: { kind: string; id: string; name: string };
}

/** One entry in a listed directory (editor file tree). */
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** A candidate definition site found for a symbol (editor ⌘-click). */
export interface DefMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  text: string;
}

/** The definition behind a hovered symbol, formatted for the hover card. */
export interface HoverInfo {
  path: string;
  line: number;
  /** Doc comment + declaration, dedented. */
  code: string;
  /** How many other definitions of the symbol exist. */
  others: number;
}

/** An open project. Each project owns its own agent + dev sessions. */
export interface Project {
  id: string;
  path: string;
  workspace: WorkspaceInfo | null;
  /** Favicon/logo pulled from the project dir, as a data URL. Null if none. */
  icon: string | null;
  /** Cached Claude Code threads, fetched on open + refreshed on demand. */
  threads: Thread[];
  /** Matched Dokploy deployment, or null if not deployed / not configured. */
  dokploy: DokployMatch | null;
}

/** Agent status derived from Claude Code hook events. */
export type SessionStatus = "idle" | "working" | "waiting";

/** Payload emitted by the Rust hook listener. */
export interface HookEvent {
  session: string;
  event: string;
  payload: string;
}

/** A working-tree change from `git status`. */
export interface GitFile {
  path: string;
  status: string;
  untracked: boolean;
}

/** Current branch plus upstream tracking / ahead-behind counts. */
export interface GitBranch {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** One matching line from a project-wide search. */
export interface SearchHit {
  /** 1-based line number. */
  line: number;
  text: string;
  /** Offsets of the match within `text`, for highlighting. */
  start: number;
  end: number;
}

/** All hits in one file, path relative to the project root. */
export interface SearchFile {
  path: string;
  hits: SearchHit[];
}

/** A slash command offered in the chat composer. */
export interface SlashCommand {
  /** Invocation without the leading slash, e.g. "review" or "caveman:compress". */
  name: string;
  description: string;
  /** "project", "user", or the plugin that provides it. */
  source: string;
}

/** One commit on a file's history timeline. */
export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  relativeDate: string;
  subject: string;
  /** The file's path at this commit (differs after a rename). */
  path: string;
  /** Set when this commit renamed the file. */
  oldPath: string | null;
}

/** One day of token usage for a project/model pair. */
export interface UsageRow {
  date: string;
  project: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  messages: number;
}

/** A saved stash entry from `git stash list`. */
export interface GitStash {
  index: number;
  label: string;
}

/** An OpenRouter model option (slug + human label). */
export interface OpenRouterModel {
  id: string;
  name: string;
}

/** A Claude Code conversation thread (resumable via its id). */
export interface Thread {
  id: string;
  title: string;
  modified: number;
}

/** One service in a Dokploy project (app, compose, or a database). */
export interface DokployService {
  name: string;
  /** application | compose | postgres | mysql | mariadb | mongo | redis */
  kind: string;
  /** The app/compose service id; null for databases (no redeploy/logs). */
  id: string | null;
  /** Deploy status (idle | running | done | error), if reported. */
  status: string | null;
}

/** The Dokploy project deploying this repo, matched by git remote. */
export interface DokployMatch {
  projectName: string;
  /** The service whose git repo matched the project's remote. */
  matchedService: string;
  services: DokployService[];
}

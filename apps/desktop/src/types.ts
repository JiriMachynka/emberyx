import type { AgentBackend } from "@/lib/agentBackend";
import type { Provider } from "@/lib/providers";

export interface PackageInfo {
  name: string;
  relPath: string;
  path: string;
  devCommand: string;
  buildCommand?: string;
  startCommand?: string;
}

/** A package with a name + version, not marked private — a ship candidate. */
export interface PublishablePackage {
  name: string;
  version: string;
  relPath: string;
  path: string;
}

export interface WorkspaceInfo {
  kind: "turbo" | "pnpm" | "npm" | "single";
  packageManager: "bun" | "pnpm" | "yarn" | "npm";
  packages: PackageInfo[];
  publishable: PublishablePackage[];
  allCommand: string | null;
  buildCommand?: string;
  startCommand?: string;
  isPython: boolean;
}

/** A workspace session shown as a tab. */
export interface Session {
  id: string;
  projectId: string;
  label: string;
  cwd: string;
  /** Shell command the session runs (dev kind only). */
  command?: string;
  kind: "dev" | "chat";
  /** Agent CLI this session drives (chat kind). */
  backend?: AgentBackend;
  /** Claude session id to resume (chat kind only). */
  resume?: string;
  /** The thread is imported history: `resume` names a thread this app can
   *  render but no CLI can continue, so the agent starts fresh. */
  imported?: boolean;
  /** The thread this session is actually on, learnt from the running agent.
   *  Kept apart from `resume` — that one is a spawn argument, and changing it
   *  under a live pane would respawn the CLI mid-turn. */
  threadId?: string;
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
  /** Set when the path is a git worktree, so the UI can label it by branch. */
  worktree: { repoRoot: string; branch: string } | null;
}

/** Live agent status shown beside a session. */
export type SessionStatus = "idle" | "working" | "waiting";

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

/** One entry from `git worktree list`. */
export interface GitWorktree {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Where a path sits in a repo: its own root, and the main checkout's root. */
export interface GitRepoRoot {
  root: string;
  mainRoot: string;
  branch: string;
  isWorktree: boolean;
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

/** One changed file in a commit, from `git log --name-status`. */
export interface GitCommitFile {
  status: string;
  path: string;
  oldPath: string | null;
}

/** One commit in the repo-wide history timeline. */
export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  relativeDate: string;
  parents: string[];
  refs: string[];
  files: GitCommitFile[];
}

/** One commit on the full-window history graph, across every ref. */
export interface GraphCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Author date, ISO-8601 — real, for tooltips and stable sorting. */
  authorDate: string;
  /** Author date relative to now, e.g. "3 days ago". */
  relativeDate: string;
  parents: string[];
  /** Ref decorations, e.g. ["HEAD -> main", "tag: v1", "origin/main"]. */
  refs: string[];
}

/** A branch, tag, or remote ref resolved to the commit it points at. */
export interface GraphRef {
  /** Full refname, e.g. "refs/heads/main". */
  name: string;
  /** Short name, e.g. "main", "v1", "origin/main". */
  shortName: string;
  kind: "branch" | "tag" | "remote";
  /** The commit sha the ref (peeled for annotated tags) targets. */
  targetSha: string;
  isHead: boolean;
  /** Tracking branch short name, when configured. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** An author or committer attribution line. */
export interface CommitAttribution {
  name: string;
  email: string;
  /** ISO-8601. */
  date: string;
}

/** The full, rendered detail for one commit. */
export interface CommitDetail {
  sha: string;
  subject: string;
  body: string;
  author: CommitAttribution;
  committer: CommitAttribution;
  parents: string[];
  files: GitCommitFile[];
}

/** One day of token usage for a project/model pair. */
export interface UsageRow {
  date: string;
  /** Which provider produced the turns. */
  provider: Provider;
  project: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  messages: number;
  /** USD the agent recorded (OpenCode, Kilo, Grok), present only when every
   *  turn in the row recorded one. Absent for Claude/Codex. */
  cost?: number;
}

/** Distinct transcripts that contributed to a usage window, per provider. */
export interface ProviderSessions {
  provider: Provider;
  count: number;
}

export interface UsageSummary {
  rows: UsageRow[];
  sessions: ProviderSessions[];
  /** Providers whose on-disk history was read; the rest are not counted. */
  counted: Provider[];
}

/** What `git_commit_and_push` did — the two halves are reported separately so a
 *  landed commit with a failed push can be told apart from a no-op. */
export interface CommitPush {
  committed: boolean;
  pushed: boolean;
  branch: string;
  needsUpstream: boolean;
  message: string;
}

/** A saved stash entry from `git stash list`. */
export interface GitStash {
  index: number;
  label: string;
}

/** A Claude Code conversation thread (resumable via its id). */
export interface Thread {
  id: string;
  title: string;
  modified: number;
  /** Which agent produced the conversation, when projections know. A thread
   *  found by scanning transcripts leaves this unset. */
  provider?: string | null;
  /** History that lives only in the local event log — imported from another
   *  app, with no transcript for the CLI to resume. */
  imported?: boolean;
}

/** Mirrors `ActivityKind` in `src-tauri/src/activity.rs`. */
export type ActivityKind =
  | "reasoning"
  | "command"
  | "fileChange"
  | "fileRead"
  | "fileSearch"
  | "fileList"
  | "search"
  | "plan"
  | "tool";

/** Mirrors `ActivityFileChange`. Line counts are absent unless the provider
 *  reported them — never zero standing in for unknown. */
export interface ActivityFileChange {
  path: string;
  additions?: number;
  deletions?: number;
}

/** One file a change activity describes, as an exact state plus the code the
 *  edit moved — what the live file tree shows while the turn runs. The code
 *  stays null until the tool input arrives (a running Write/Edit holds its
 *  arguments until the block closes) — never an empty string for unknown. */
export interface ActivityFileEdit {
  state: "created" | "modified" | "deleted";
  before: string | null;
  after: string | null;
}

/** One unit of agent work, normalized in Rust and ready to render. Mirrors
 *  `ActivityItem`; `displayTarget` and friends are computed once on arrival,
 *  so the renderer never reparses a tool input on a frame. */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  arguments?: string;
  output?: string;
  displayTarget?: string;
  displayDescription?: string;
  fileChanges?: ActivityFileChange[];
  failed: boolean;
  /** False while the work is still running — a tool with no result yet. */
  complete: boolean;
  /** The client answered this call's permission request for the user — the
   *  access level said to, or TypeSafe Jev scored it as low-risk. Set by the
   *  ACP transport only: Claude and Codex carry the level into the process,
   *  so nothing is decided here for them and the Rust normalizer never sets
   *  this. */
  autoApproved?: boolean;
}


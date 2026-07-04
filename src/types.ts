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
  kind: "agent" | "dev";
}

/** An open project. Each project owns its own agent + dev sessions. */
export interface Project {
  id: string;
  path: string;
  workspace: WorkspaceInfo | null;
  /** Cached Claude Code threads, fetched on open + refreshed on demand. */
  threads: Thread[];
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

/** A Claude Code conversation thread (resumable via its id). */
export interface Thread {
  id: string;
  title: string;
  modified: number;
}

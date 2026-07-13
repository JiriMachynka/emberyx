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
  /** Stable key for cross-restart scrollback restore; only the project's
   *  primary agent sets it, so secondary/dev panes never share its log. */
  persistKey?: string;
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
}

/** One service in a Dokploy project (app, compose, or a database). */
export interface DokployService {
  name: string;
  /** application | compose | postgres | mysql | mariadb | mongo | redis */
  kind: string;
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

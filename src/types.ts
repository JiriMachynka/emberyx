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
  label: string;
  cwd: string;
  command?: string;
  kind: "agent" | "dev";
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

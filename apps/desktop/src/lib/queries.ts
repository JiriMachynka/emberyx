import {
  QueryClient,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type {
  DirEntry,
  GitBranch,
  GitCommit,
  GitFile,
  GitLogEntry,
  GitRepoRoot,
  GitStash,
  GitWorktree,
  OpenRouterModel,
  SearchFile,
  SlashCommand,
  UsageRow,
} from "@/types";
import { listCodexModels, listCodexSkills } from "@/lib/codex/transport";
import type { AgentBackend } from "@/lib/agentBackend";
import type { ProviderStatus } from "@/lib/providers";
import { forgeCommands, type RemoteHost } from "@/lib/forge";
import type {
  ConflictStages,
  MergeRequest,
  MergeRequestDetail,
  MrDiffFile,
  MrNote,
  MrState,
} from "@/lib/gitlab";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2_000,
      retry: false,
      refetchOnWindowFocus: true,
    },
  },
});

// Git queries are keyed by repo path so multiple components (ContextBar,
// ChangesPanel, GitActions) share one cache entry and one fetch per path.
export const gitKeys = {
  changes: (path: string) => ["git", "changes", path] as const,
  diff: (path: string, file: string, untracked: boolean, staged: boolean) =>
    ["git", "diff", path, file, untracked, staged] as const,
  branch: (path: string) => ["git", "branch", path] as const,
  remoteHost: (path: string) => ["git", "remoteHost", path] as const,
  branches: (path: string) => ["git", "branches", path] as const,
  mergedBranches: (path: string) => ["git", "mergedBranches", path] as const,
  stashes: (path: string) => ["git", "stashes", path] as const,
  worktrees: (path: string) => ["git", "worktrees", path] as const,
  repoRoot: (path: string) => ["git", "repoRoot", path] as const,
  conflicts: (path: string) => ["git", "conflicts", path] as const,
  mergeState: (path: string) => ["git", "mergeState", path] as const,
  conflictStages: (path: string, file: string) =>
    ["git", "conflictStages", path, file] as const,
  log: (path: string, file: string) => ["git", "log", path, file] as const,
  show: (path: string, sha: string, file: string) =>
    ["git", "show", path, sha, file] as const,
  pickaxe: (path: string, file: string, term: string) =>
    ["git", "pickaxe", path, file, term] as const,
  commits: (path: string, limit: number) =>
    ["git", "commits", path, limit] as const,
  commitDiff: (path: string, sha: string, file: string) =>
    ["git", "commitDiff", path, sha, file] as const,
};

export const useGitChanges = (path: string, enabled = true) =>
  useQuery({
    queryKey: gitKeys.changes(path),
    queryFn: () => invoke<GitFile[]>("git_changes", { path }),
    enabled,
  });

const fileDiff = (path: string, file: GitFile, staged: boolean) =>
  queryClient.fetchQuery({
    queryKey: gitKeys.diff(path, file.path, file.untracked, staged),
    queryFn: () =>
      invoke<string>("git_file_diff", {
        path,
        file: file.path,
        untracked: file.untracked,
        staged,
      }),
  });

/** The whole working tree's diff, per file, staged parts included. Goes through
 *  the same cache entries the changes panel fills, so an open panel pays once. */
export const fetchWorkingDiff = async (path: string): Promise<string> => {
  const files = await queryClient.fetchQuery({
    queryKey: gitKeys.changes(path),
    queryFn: () => invoke<GitFile[]>("git_changes", { path }),
  });
  const parts = await Promise.all(
    files.map(async (f) => {
      // The index column is blank for a purely unstaged edit; anything else
      // means part of the change only shows under `--cached`.
      const staged =
        !f.untracked && f.status[0] !== " " ? await fileDiff(path, f, true) : "";
      const unstaged = await fileDiff(path, f, false);
      const body = [staged, unstaged].map((d) => d.trim()).filter(Boolean).join("\n");
      return body ? `--- ${f.path}\n${body}` : "";
    })
  );
  return parts.filter(Boolean).join("\n\n");
};

// `file` null → disabled; the key includes the file so a fast A→B selection
// can't land A's diff under B's selection (the stale query is dropped).
export const useGitFileDiff = (
  path: string,
  file: string | null,
  untracked: boolean,
  staged: boolean
) =>
  useQuery({
    queryKey: gitKeys.diff(path, file ?? "", untracked, staged),
    queryFn: () =>
      invoke<string>("git_file_diff", { path, file, untracked, staged }),
    enabled: !!file,
  });

/** A file's commit history, newest first, following renames. */
export const useGitFileLog = (path: string, file: string | null) =>
  useQuery({
    queryKey: gitKeys.log(path, file ?? ""),
    queryFn: () => invoke<GitCommit[]>("git_file_log", { path, file }),
    enabled: !!file,
    staleTime: 30_000,
  });

/** A file's contents at one commit. `file` is its path *at that commit*. */
export const useGitShowFile = (
  path: string,
  sha: string | null,
  file: string | null
) =>
  useQuery({
    queryKey: gitKeys.show(path, sha ?? "", file ?? ""),
    queryFn: () => invoke<string>("git_show_file", { path, sha, file }),
    enabled: !!sha && !!file,
    staleTime: Infinity,
  });

/** Shas of commits that added or removed `term` in this file (`git log -S`). */
export const useGitPickaxe = (path: string, file: string | null, term: string) =>
  useQuery({
    queryKey: gitKeys.pickaxe(path, file ?? "", term),
    queryFn: () => invoke<string[]>("git_pickaxe", { path, file, term }),
    enabled: !!file && term.trim().length > 0,
    staleTime: 30_000,
  });

/** Repo-wide commit timeline; grow `limit` to page in older commits. */
export const useGitLog = (path: string, limit: number) =>
  useQuery({
    queryKey: gitKeys.commits(path, limit),
    queryFn: () => invoke<GitLogEntry[]>("git_log", { path, limit }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

/** The diff one commit introduced to one file. */
export const useGitCommitDiff = (
  path: string,
  sha: string | null,
  file: string | null
) =>
  useQuery({
    queryKey: gitKeys.commitDiff(path, sha ?? "", file ?? ""),
    queryFn: () => invoke<string>("git_commit_diff", { path, sha, file }),
    enabled: !!sha && !!file,
    staleTime: Infinity,
  });

export const useGitBranch = (path: string) =>
  useQuery({
    queryKey: gitKeys.branch(path),
    // Throws when the dir isn't a repo / has no commits — data stays undefined.
    queryFn: () => invoke<GitBranch>("git_branch", { path }),
  });

export type GitRemoteHost = "github" | "gitlab" | "other";

/** Classifies the origin remote's host. Effectively immutable for a checkout. */
export const useGitRemoteHost = (path: string) =>
  useQuery({
    queryKey: gitKeys.remoteHost(path),
    queryFn: () => invoke<GitRemoteHost>("git_remote_host", { path }),
    staleTime: Infinity,
  });

export const useGitBranches = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: gitKeys.branches(path),
    queryFn: () => invoke<string[]>("git_branches", { path }),
    enabled,
  });

/** Branches already merged into the default branch, per repo root, for settling
 *  their threads. `useQueries` because the roots are only known at render —
 *  several worktrees of one repo collapse to one key, and so one call. */
export const useMergedBranchesMap = (
  roots: string[],
  enabled: boolean
): Record<string, string[]> => {
  const results = useQueries({
    queries: roots.map((root) => ({
      queryKey: gitKeys.mergedBranches(root),
      queryFn: () => invoke<string[]>("git_merged_branches", { path: root }),
      enabled,
    })),
  });
  const map: Record<string, string[]> = {};
  roots.forEach((root, i) => {
    map[root] = results[i]?.data ?? [];
  });
  return map;
};

export const useGitWorktrees = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: gitKeys.worktrees(path),
    queryFn: () => invoke<GitWorktree[]>("git_worktrees", { path }),
    enabled,
  });

export const useGitRepoRoot = (path: string) =>
  useQuery({
    queryKey: gitKeys.repoRoot(path),
    queryFn: () => invoke<GitRepoRoot>("git_repo_root", { path }),
    // A checkout never changes which repo owns it.
    staleTime: Infinity,
  });

export const useGitStashes = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: gitKeys.stashes(path),
    queryFn: () => invoke<GitStash[]>("git_stash_list", { path }),
    enabled,
  });

/** Refetch every git view for a repo after a mutating op (commit, checkout…).
 *  `also` refreshes a second path too — a mutation inside a worktree changes
 *  what the main repo's views show. */
export const useInvalidateGit = () => {
  const qc = useQueryClient();
  return (path: string, also?: string) => {
    for (const p of also ? [path, also] : [path]) {
      const views = [
        "changes",
        "diff",
        "branch",
        "branches",
        "stashes",
        "log",
        "commits",
        "commitDiff",
        "worktrees",
        "conflicts",
        "mergeState",
        "conflictStages",
      ];
      for (const key of views) {
        qc.invalidateQueries({ queryKey: ["git", key, p] });
      }
    }
  };
};

/** Paths left conflicted by an in-progress merge. Reflects disk, so it is never
 *  served stale — a resolve outside this hook must show up immediately. */
export const useGitConflicts = (path: string) =>
  useQuery({
    queryKey: gitKeys.conflicts(path),
    queryFn: () => invoke<string[]>("git_conflicts", { path }),
    staleTime: 0,
  });

/** Whether MERGE_HEAD exists — i.e. a merge is waiting to be finished. */
export const useGitMergeState = (path: string) =>
  useQuery({
    queryKey: gitKeys.mergeState(path),
    queryFn: () => invoke<boolean>("git_merge_state", { path }),
    staleTime: 0,
  });

/** base/ours/theirs/merged for one conflicted file. `file` null → disabled. */
export const useGitConflictStages = (path: string, file: string | null) =>
  useQuery({
    queryKey: gitKeys.conflictStages(path, file ?? ""),
    queryFn: () =>
      invoke<ConflictStages>("git_conflict_stages", { path, file }),
    enabled: !!file,
    staleTime: 0,
  });

// GitLab reads go over the network, so they carry a longer staleTime than the
// local git views. A missing token surfaces as a query error, not a crash —
// hence `retry: false` throughout.
export const forgeKeys = {
  token: (host: RemoteHost) => ["forge", host, "token"] as const,
  mrs: (host: RemoteHost, path: string, state: MrState) =>
    ["forge", host, "mrs", path, state] as const,
  mr: (host: RemoteHost, path: string, iid: number) =>
    ["forge", host, "mr", path, iid] as const,
  diff: (host: RemoteHost, path: string, iid: number) =>
    ["forge", host, "diff", path, iid] as const,
  notes: (host: RemoteHost, path: string, iid: number) =>
    ["forge", host, "notes", path, iid] as const,
};

/** Whether a personal access token for `host` is stored in the OS keychain. */
export const useForgeToken = (host: RemoteHost) =>
  useQuery({
    queryKey: forgeKeys.token(host),
    queryFn: () => invoke<boolean>(forgeCommands(host).hasToken),
    staleTime: Infinity,
    retry: false,
  });

/** `path` null → disabled; the project's git remote picks the repo. */
export const useForgeMrs = (
  host: RemoteHost,
  path: string | null,
  state: MrState
) =>
  useQuery({
    queryKey: forgeKeys.mrs(host, path ?? "", state),
    queryFn: () => invoke<MergeRequest[]>(forgeCommands(host).list, { path, state }),
    enabled: !!path,
    staleTime: 30_000,
    retry: false,
  });

export const useForgeMr = (
  host: RemoteHost,
  path: string | null,
  iid: number | null
) =>
  useQuery({
    queryKey: forgeKeys.mr(host, path ?? "", iid ?? 0),
    queryFn: () => invoke<MergeRequestDetail>(forgeCommands(host).detail, { path, iid }),
    enabled: !!path && iid !== null,
    staleTime: 30_000,
    retry: false,
  });

export const useForgeMrDiff = (
  host: RemoteHost,
  path: string | null,
  iid: number | null
) =>
  useQuery({
    queryKey: forgeKeys.diff(host, path ?? "", iid ?? 0),
    queryFn: () => invoke<MrDiffFile[]>(forgeCommands(host).diff, { path, iid }),
    enabled: !!path && iid !== null,
    staleTime: 30_000,
    retry: false,
  });

export const useForgeMrNotes = (
  host: RemoteHost,
  path: string | null,
  iid: number | null
) =>
  useQuery({
    queryKey: forgeKeys.notes(host, path ?? "", iid ?? 0),
    queryFn: () => invoke<MrNote[]>(forgeCommands(host).notes, { path, iid }),
    enabled: !!path && iid !== null,
    staleTime: 30_000,
    retry: false,
  });

/** Refetch every forge view — after saving/clearing a token or acting on a
 *  change. Takes the client directly so non-hook callers can use it. */
export const invalidateForge = (qc: QueryClient) => {
  qc.invalidateQueries({ queryKey: ["forge"] });
};

// Provider install/auth detection, for the Settings → Providers surface.
export const providerKeys = {
  status: () => ["providers", "status"] as const,
};

/** Install + version probe for every provider CLI. Rescan on demand. */
export const useProviderStatus = () =>
  useQuery({
    queryKey: providerKeys.status(),
    queryFn: () => invoke<ProviderStatus[]>("provider_status"),
    staleTime: 30_000,
    retry: false,
  });

export const invalidateProviders = (qc: QueryClient) => {
  qc.invalidateQueries({ queryKey: ["providers"] });
};

/** The persistent-agent daemon, if one is running. */
export interface DaemonHealth {
  ok: boolean;
  version: string;
  pid: number;
  uptimeMs: number;
  agentCount: number;
  eventCount: number;
}

export const daemonKeys = {
  health: () => ["daemon", "health"] as const,
};

/**
 * Is `emberyxd` up? A rejected call is the honest answer "not running", not an
 * error state — the daemon is optional, and the UI has to be able to say that
 * agents will not survive the window before the user finds out the hard way.
 */
export const useDaemonHealth = (enabled = true) =>
  useQuery({
    queryKey: daemonKeys.health(),
    queryFn: () =>
      invoke<DaemonHealth>("daemon_health").catch(() => null),
    enabled,
    refetchInterval: 10_000,
    retry: false,
  });

export const invalidateDaemon = (qc: QueryClient) => {
  qc.invalidateQueries({ queryKey: ["daemon"] });
};

// Editor file-tree + buffer reads, keyed by absolute path.
export const fileKeys = {
  dir: (path: string) => ["files", "dir", path] as const,
  all: (path: string) => ["files", "all", path] as const,
  text: (path: string) => ["files", "text", path] as const,
};

/** Flat recursive file list for the editor's ⌘K finder. Fetched when the
 *  finder first opens and kept for the session — a re-walk per keystroke would
 *  be wasteful, and new files are rare mid-session. */
export const useProjectFiles = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: fileKeys.all(path),
    queryFn: () => invoke<string[]>("list_files", { path }),
    enabled,
    staleTime: 60_000,
  });

export const useDirEntries = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: fileKeys.dir(path),
    queryFn: () => invoke<DirEntry[]>("list_dir", { path }),
    enabled,
  });

/** `path` null → disabled. Never auto-refetches: the pane owns an editable
 *  buffer, so a background refetch would fight the user's typing. */
export const useFileText = (path: string | null) =>
  useQuery({
    queryKey: fileKeys.text(path ?? ""),
    queryFn: () => invoke<string>("read_text_file", { path }),
    enabled: !!path,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

export const searchKeys = {
  text: (path: string, query: string, caseSensitive: boolean, isRegex: boolean) =>
    ["search", path, query, caseSensitive, isRegex] as const,
};

/** Project-wide content search. Disabled until the query is submitted — the
 *  walk touches every file, so it must not fire per keystroke. */
export const useSearchText = (
  path: string,
  query: string,
  caseSensitive: boolean,
  isRegex: boolean
) =>
  useQuery({
    queryKey: searchKeys.text(path, query, caseSensitive, isRegex),
    queryFn: () =>
      invoke<SearchFile[]>("search_text", {
        path,
        query,
        caseSensitive,
        isRegex,
      }),
    enabled: query.length > 0,
    staleTime: 30_000,
  });

export const slashKeys = {
  commands: (cwd: string, backend: AgentBackend) => ["slash", backend, cwd] as const,
};

/** The commands a project offers, in whichever form the backend has them:
 *  Claude's command files (project + user + plugin), scanned in Rust, or
 *  Codex's skills, listed by the app-server. Fetched on the first sigil typed
 *  and kept for the session — both rarely change mid-session, and the menu
 *  refetches when a chat pane remounts. */
export const useSlashCommands = (
  cwd: string,
  enabled: boolean,
  backend: AgentBackend = "claude"
) =>
  useQuery({
    queryKey: slashKeys.commands(cwd, backend),
    queryFn: () =>
      backend === "codex"
        ? listCodexSkills(cwd)
        : invoke<SlashCommand[]>("slash_commands", { cwd }),
    enabled,
    staleTime: 5 * 60 * 1000,
  });

export const codexKeys = { models: ["codex", "models"] as const };

/** Codex's model catalog. Account-wide, so it isn't keyed by project, and it
 *  only loads once the picker that needs it is mounted. */
export const useCodexModels = (cwd: string, enabled: boolean) =>
  useQuery({
    queryKey: codexKeys.models,
    queryFn: () => listCodexModels(cwd),
    enabled,
    staleTime: Infinity,
  });

export const usageKeys = { summary: (days: number) => ["usage", days] as const };

/** Cross-project token usage for the last `days`, one row per day/project/model. */
export const useUsageSummary = (days: number, enabled: boolean) =>
  useQuery({
    queryKey: usageKeys.summary(days),
    queryFn: () => invoke<UsageRow[]>("usage_summary", { days }),
    enabled,
    staleTime: 60_000,
  });

export const openRouterKeys = { models: () => ["openrouter", "models"] as const };

export const useOpenRouterModels = (enabled: boolean) =>
  useQuery({
    queryKey: openRouterKeys.models(),
    queryFn: () => invoke<OpenRouterModel[]>("openrouter_models"),
    enabled,
    staleTime: 60 * 60 * 1000, // Model list rarely changes.
  });

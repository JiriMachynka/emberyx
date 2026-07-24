import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type {
  DirEntry,
  GitBranch,
  GitCommit,
  GitFile,
  GitRepoRoot,
  GitStash,
  GitWorktree,
  OpenRouterModel,
  SearchFile,
  SlashCommand,
  UsageRow,
} from "@/types";

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
  branches: (path: string) => ["git", "branches", path] as const,
  stashes: (path: string) => ["git", "stashes", path] as const,
  worktrees: (path: string) => ["git", "worktrees", path] as const,
  repoRoot: (path: string) => ["git", "repoRoot", path] as const,
  log: (path: string, file: string) => ["git", "log", path, file] as const,
  show: (path: string, sha: string, file: string) =>
    ["git", "show", path, sha, file] as const,
  pickaxe: (path: string, file: string, term: string) =>
    ["git", "pickaxe", path, file, term] as const,
};

export const useGitChanges = (path: string) =>
  useQuery({
    queryKey: gitKeys.changes(path),
    queryFn: () => invoke<GitFile[]>("git_changes", { path }),
  });

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

export const useGitBranch = (path: string) =>
  useQuery({
    queryKey: gitKeys.branch(path),
    // Throws when the dir isn't a repo / has no commits — data stays undefined.
    queryFn: () => invoke<GitBranch>("git_branch", { path }),
  });

export const useGitBranches = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: gitKeys.branches(path),
    queryFn: () => invoke<string[]>("git_branches", { path }),
    enabled,
  });

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
      const views = ["changes", "diff", "branch", "branches", "stashes", "log", "worktrees"];
      for (const key of views) {
        qc.invalidateQueries({ queryKey: ["git", key, p] });
      }
    }
  };
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

export const slashKeys = { commands: (cwd: string) => ["slash", cwd] as const };

/** Slash commands available in a project (project + user + plugin). Fetched on
 *  the first `/` typed and kept for the session — command files rarely change
 *  mid-session, and the menu refetches when a chat pane remounts. */
export const useSlashCommands = (cwd: string, enabled: boolean) =>
  useQuery({
    queryKey: slashKeys.commands(cwd),
    queryFn: () => invoke<SlashCommand[]>("slash_commands", { cwd }),
    enabled,
    staleTime: 5 * 60 * 1000,
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

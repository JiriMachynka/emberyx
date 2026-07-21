import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { GitBranch, GitFile, GitStash, OpenRouterModel } from "@/types";

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
  diff: (path: string, file: string, untracked: boolean) =>
    ["git", "diff", path, file, untracked] as const,
  branch: (path: string) => ["git", "branch", path] as const,
  branches: (path: string) => ["git", "branches", path] as const,
  stashes: (path: string) => ["git", "stashes", path] as const,
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
  untracked: boolean
) =>
  useQuery({
    queryKey: gitKeys.diff(path, file ?? "", untracked),
    queryFn: () => invoke<string>("git_file_diff", { path, file, untracked }),
    enabled: !!file,
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

export const useGitStashes = (path: string, enabled: boolean) =>
  useQuery({
    queryKey: gitKeys.stashes(path),
    queryFn: () => invoke<GitStash[]>("git_stash_list", { path }),
    enabled,
  });

/** Refetch every git view for a repo after a mutating op (commit, checkout…). */
export const useInvalidateGit = () => {
  const qc = useQueryClient();
  return (path: string) => {
    for (const key of ["changes", "diff", "branch", "branches", "stashes"]) {
      qc.invalidateQueries({ queryKey: ["git", key, path] });
    }
  };
};

export const openRouterKeys = { models: () => ["openrouter", "models"] as const };

export const useOpenRouterModels = (enabled: boolean) =>
  useQuery({
    queryKey: openRouterKeys.models(),
    queryFn: () => invoke<OpenRouterModel[]>("openrouter_models"),
    enabled,
    staleTime: 60 * 60 * 1000, // Model list rarely changes.
  });

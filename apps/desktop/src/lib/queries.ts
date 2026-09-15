import { useMemo, useSyncExternalStore } from "react";
import {
  QueryClient,
  useMutation,
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
  SearchFile,
  SlashCommand,
  UsageSummary,
} from "@/types";
import { listCodexModels, listCodexSkills } from "@/lib/codex/transport";
import { readAcpModels } from "@/lib/acp/transport";
import { loadSettings } from "@/lib/settings";
import { claudeModelEntries, claudePinsFromCatalog } from "@/lib/modelCatalog";
import { pricingCatalogIds, subscribePricing } from "@/lib/pricing";
import {
  checkpointTurnContents,
  checkpointTurnFiles,
  checkpointTurnPatch,
  listCheckpoints,
  type Checkpoint,
} from "@/lib/checkpoints";
import type { AgentBackend } from "@/lib/agentBackend";
import type { ProviderStatus } from "@/lib/providers";
import type {
  McpAddSpec,
  McpHarness,
  McpServerInfo,
} from "@/lib/mcp";
import type { SkillAddSpec, SkillInfo } from "@/lib/skills";
import { forgeCommands, type LinkedPr, type RemoteHost } from "@/lib/forge";
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
      // Git status/diff on every alt-tab is the lag; mutations still
      // invalidate explicitly via `useInvalidateGit`.
      refetchOnWindowFocus: false,
    },
  },
});

// Git queries are keyed by repo path so multiple components (ContextBar,
// ChangesPanel, GitActions) share one cache entry and one fetch per path.
export const gitKeys = {
  changes: (path: string) => ["git", "changes", path] as const,
  workingDiff: (path: string, staged: boolean, ignoreWhitespace: boolean) =>
    ["git", "workingDiff", path, staged, ignoreWhitespace] as const,
  branch: (path: string) => ["git", "branch", path] as const,
  /** Branch query key carrying the HEAD snapshot a poll noticed — the one
   *  `useGitBranch` reads, while per-key *inline* branches (useBranchMap)
   *  stay on the locator without it. */
  snapshotBranch: (path: string, head: string) =>
    ["git", "branch", path, head] as const,
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
  defaultBranch: (path: string) => ["git", "defaultBranch", path] as const,
};

export const useGitChanges = (path: string, enabled = true) =>
  useQuery({
    queryKey: gitKeys.changes(path),
    queryFn: () => invoke<GitFile[]>("git_changes", { path }),
    enabled,
  });

// Turn-review queries. The Rust side resolves each turn's range end (settle
// snapshot → next checkpoint → working tree), so a range's answer can change
// exactly once — the moment its settle lands — and nothing here caches
// forever. Keys put the repo path second so `useInvalidateGit` can flush.
export const checkpointKeys = {
  thread: (path: string, threadId: string) =>
    ["checkpoints", path, "thread", threadId] as const,
  turnFiles: (path: string, threadId: string, fromId: string) =>
    ["checkpoints", path, "turnFiles", threadId, fromId] as const,
  turnPatch: (path: string, threadId: string, fromId: string) =>
    ["checkpoints", path, "turnPatch", threadId, fromId] as const,
  turnContents: (path: string, threadId: string, fromId: string, file: string) =>
    ["checkpoints", path, "turnContents", threadId, fromId, file] as const,
};

export const useThreadCheckpoints = (
  path: string,
  threadId: string | null
) =>
  useQuery({
    queryKey: checkpointKeys.thread(path, threadId ?? ""),
    queryFn: (): Promise<Checkpoint[]> => listCheckpoints(path, threadId ?? undefined),
    enabled: !!threadId,
    staleTime: 30_000,
  });

/**
 * The files one turn changed.
 *
 * `openEnded` is the newest turn, whose range ends at the working tree and so
 * changes with every git mutation. Every older turn's range is closed by the
 * next turn's snapshot and can never move again — those are cached for good,
 * because the transcript is virtualized and a card that refetched on every
 * remount fired a git subprocess per scroll.
 */
export const useTurnFiles = (
  path: string,
  threadId: string | null,
  fromId: string | null,
  enabled = true,
  openEnded = true
) =>
  useQuery({
    queryKey: checkpointKeys.turnFiles(path, threadId ?? "", fromId ?? ""),
    queryFn: () => checkpointTurnFiles(path, threadId ?? "", fromId ?? ""),
    enabled: enabled && !!fromId && !!threadId,
    staleTime: openEnded ? 0 : Infinity,
    gcTime: openEnded ? undefined : Infinity,
    meta: { openEnded },
  });

/** The whole turn as one patch — the review surface's source. */
export const useTurnPatch = (
  path: string,
  threadId: string | null,
  fromId: string | null
) =>
  useQuery({
    queryKey: checkpointKeys.turnPatch(path, threadId ?? "", fromId ?? ""),
    queryFn: () => checkpointTurnPatch(path, threadId ?? "", fromId ?? ""),
    enabled: !!fromId && !!threadId,
    staleTime: 0,
  });

/** Full both-sides contents for one file, for the diff renderer's context
 *  expansion. Read through the cache so re-expanding one file pays once. */
export const fetchTurnContents = (
  path: string,
  threadId: string,
  fromId: string,
  file: string
) =>
  queryClient.fetchQuery({
    queryKey: checkpointKeys.turnContents(path, threadId, fromId, file),
    queryFn: () => checkpointTurnContents(path, threadId, fromId, file),
    staleTime: 0,
  });

/**
 * Freeze a turn's file delta: snapshot the working tree now under the turn's
 * checkpoint id. Best-effort — a missed settle only means the delta runs to
 * the next snapshot instead — but a landed one invalidates the turn views, so
 * cards flip from "everything since" to "exactly this turn".
 */
export const settleTurnCheckpoint = async (
  path: string,
  checkpointId: string
): Promise<void> => {
  try {
    await invoke("checkpoint_settle", { path, checkpointId });
  } catch {
    return;
  }
  await queryClient.invalidateQueries({ queryKey: ["checkpoints", path] });
};

/** The whole working tree as one patch, staged parts included — what a handoff
 *  package carries. Two git subprocesses (index and working tree), not one per
 *  file: a wide tree used to spawn hundreds. Read outside the render tree, so
 *  the whitespace setting comes from storage. */
export const fetchWorkingDiff = async (path: string): Promise<string> => {
  const ignoreWhitespace = loadSettings().diffIgnoreWhitespace;
  const halves = await Promise.all(
    [true, false].map((staged) =>
      queryClient.fetchQuery({
        queryKey: gitKeys.workingDiff(path, staged, ignoreWhitespace),
        queryFn: () =>
          invoke<string>("git_working_diff", { path, staged, ignoreWhitespace }),
      })
    )
  );
  return halves.map((d) => d.trim()).filter(Boolean).join("\n");
};

/** The whole working tree as one multi-file patch — what the changes panel
 *  renders. One query rather than one per file: the panel shows every file in a
 *  single scroll, and N queries would each be a git subprocess. */
export const useGitWorkingDiff = (
  path: string,
  staged: boolean,
  ignoreWhitespace: boolean,
  enabled: boolean
) =>
  useQuery({
    queryKey: gitKeys.workingDiff(path, staged, ignoreWhitespace),
    queryFn: () =>
      invoke<string>("git_working_diff", { path, staged, ignoreWhitespace }),
    enabled: enabled && !!path,
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

/**
 * The branch this repo's HEAD is on. A branch moved outside the app (the
 * terminal, an editor) should appear in the composer without a user round
 * trip, so a poll of the repo's HEAD file precedes the real query: HEAD
 * snapshot sits in the key, and once a checkout rewrites it the branch query
 * is a different cache entry and refetches on its own. The probe spawns no
 * process — it reads one file.
 */
export const useGitBranch = (path: string) => {
  const snapshot = useQuery({
    queryKey: ["git", "branchHead", path] as const,
    queryFn: () => invoke<string>("git_head_ref", { path }),
    refetchInterval: 2_000,
    staleTime: Infinity,
    retry: false,
  });
  return useQuery({
    queryKey: gitKeys.snapshotBranch(path, snapshot.data ?? ""),
    // Throws when the dir isn't a repo / has no commits — data stays undefined.
    queryFn: () => invoke<GitBranch>("git_branch", { path }),
  });
};

export type GitRemoteHost = "github" | "gitlab" | "other";

/** Classifies the origin remote's host. Effectively immutable for a checkout. */
/** The branch this repo's work merges into. Null when it can't be told, which
 *  callers must read as "not the default branch" rather than guessing. */
export const useGitDefaultBranch = (path: string) =>
  useQuery({
    queryKey: gitKeys.defaultBranch(path),
    queryFn: () => invoke<string | null>("git_default_branch", { path }),
    staleTime: Infinity,
    retry: false,
  });

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
/** Current branch per project, one query each — the thread inbox shows a branch
 *  on every row and would otherwise fire a hook inside a loop. */
export const useBranchMap = (paths: string[]): Record<string, string> => {
  const results = useQueries({
    queries: paths.map((path) => ({
      queryKey: gitKeys.branch(path),
      queryFn: () => invoke<GitBranch>("git_branch", { path }),
    })),
  });
  // Rebuilt only when a branch name actually moved. `paths` and `results` are
  // fresh arrays every render, but this map's *identity* is a dependency of the
  // sidebar's whole sort-and-partition memo — returning a new object each time
  // silently defeated it.
  const key = paths
    .map((path, i) => `${path}\u0000${results[i]?.data?.branch ?? ""}`)
    .join("\u001f");
  return useMemo(() => {
    const map: Record<string, string> = {};
    paths.forEach((path, i) => {
      const branch = results[i]?.data?.branch;
      if (branch) map[path] = branch;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes both
  }, [key]);
};

/** Merged PR/MR iids for linked-thread settle. One detail fetch per link —
 *  linked threads are few, and the list endpoint is the wrong grain. */
export const useLinkedPrMerged = (
  links: Array<{ path: string; pr: LinkedPr }>,
  enabled: boolean
): Set<string> => {
  const results = useQueries({
    queries: links.map(({ path, pr }) => ({
      queryKey: ["forge", "linkedPr", path, pr.host, pr.iid] as const,
      queryFn: () =>
        invoke<{ state: string }>(forgeCommands(pr.host).detail, {
          path,
          iid: pr.iid,
        }),
      enabled,
      staleTime: 60_000,
    })),
  });
  // Same reason as `useBranchMap`: a fresh Set per render invalidates the
  // sidebar memo that consumes it.
  const key = links
    .map(({ path, pr }, i) => `${path}:${pr.host}:${pr.iid}=${results[i]?.data?.state ?? ""}`)
    .join("\u001f");
  return useMemo(() => {
    const merged = new Set<string>();
    links.forEach(({ path, pr }, i) => {
      if (results[i]?.data?.state === "merged") {
        merged.add(`${path}:${pr.host}:${pr.iid}`);
      }
    });
    return merged;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes both
  }, [key]);
};

export const useMergedBranchesMap = (
  roots: string[],
  enabled: boolean
): Record<string, string[]> => {
  const results = useQueries({
    queries: roots.map((root) => ({
      queryKey: gitKeys.mergedBranches(root),
      queryFn: () => invoke<string[]>("git_merged_branches", { path: root }),
      enabled,
      // A `git branch --merged` per open repo. The 2s default made every
      // window focus a burst of them; merge state does not move that fast.
      staleTime: 30_000,
    })),
  });
  // Identity-stable for the same reason as the two hooks above.
  const key = roots
    .map((root, i) => `${root}=${(results[i]?.data ?? []).join(",")}`)
    .join("\u001f");
  return useMemo(() => {
    const map: Record<string, string[]> = {};
    roots.forEach((root, i) => {
      map[root] = results[i]?.data ?? [];
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes both
  }, [key]);
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
        "remoteHost",
        "defaultBranch",
      ];
      // Turn-review ranges: the open-ended newest turn's answer changes with
      // every git mutation, and settle snapshots land between invalidations.
      // A closed range cannot move, so it is left alone — otherwise every card
      // the transcript has mounted refires its git subprocess at once.
      qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "checkpoints" &&
          q.queryKey[1] === p &&
          q.meta?.openEnded !== false,
      });
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

// Forge reads go over the network, so they carry a longer staleTime than the
// local git views. A missing CLI login surfaces as a query error, not a crash —
// hence `retry: false` throughout.
export const forgeKeys = {
  mrs: (host: RemoteHost, path: string, state: MrState) =>
    ["forge", host, "mrs", path, state] as const,
  mr: (host: RemoteHost, path: string, iid: number) =>
    ["forge", host, "mr", path, iid] as const,
  diff: (host: RemoteHost, path: string, iid: number) =>
    ["forge", host, "diff", path, iid] as const,
  notes: (host: RemoteHost, path: string, iid: number) =>
    ["forge", host, "notes", path, iid] as const,
};

export interface ForgeCliStatus {
  id: RemoteHost;
  label: string;
  binary: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean;
}

/** The open PR/MR for a branch, or null. Never throws: it only decides a button
 *  label, so a missing or unauthenticated CLI must not surface as an error. */
export const useForgeOpenPr = (
  path: string,
  provider: RemoteHost | undefined,
  branch: string | undefined
) =>
  useQuery({
    queryKey: ["forgeCli", "openPr", path, provider ?? "", branch ?? ""],
    queryFn: () =>
      invoke<string | null>("forge_pr_for_branch", { path, provider, branch }),
    enabled: !!path && !!branch && (provider === "github" || provider === "gitlab"),
    staleTime: 30_000,
    retry: false,
  });

/** Install + login probe for `gh` and `glab`, Settings → Source Control. The
 *  probe shells out per CLI and reads the keychain, so callers that only need
 *  it on one tab pass `enabled` rather than paying for it on every open.
 *  Installed CLIs don't change mid-session, hence the long staleTime. */
export const useForgeCliStatus = (enabled = true) =>
  useQuery({
    queryKey: ["forgeCli", "status"],
    queryFn: () => invoke<ForgeCliStatus[]>("forge_cli_status"),
    enabled,
    staleTime: 5 * 60_000,
    // Alt-tabbing back is not a reason to shell out to `gh` and the keychain
    // again; Settings invalidates this explicitly when it rescans.
    refetchOnWindowFocus: false,
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

/** This machine's human name, for the thread inbox's detail card. Fixed for the
 *  life of the process — asked once. */
export const useMachineName = () =>
  useQuery({
    queryKey: ["machine", "name"],
    queryFn: () => invoke<string>("machine_name"),
    staleTime: Infinity,
  });

/** Refetch every forge view — after saving/clearing a token or acting on a
 *  change. Takes the client directly so non-hook callers can use it. */
export const invalidateForge = (qc: QueryClient) => {
  qc.invalidateQueries({ queryKey: ["forge"] });
  qc.invalidateQueries({ queryKey: ["forgeCli"] });
};

// Provider install/auth detection, for the Settings → Providers surface.
export const providerKeys = {
  status: (commands: Record<string, string>) =>
    ["providers", "status", commands] as const,
};

/** Binary overrides, provider id → command. Detection resolves the binary the
 *  app would actually spawn; without these a provider you are chatting with
 *  through an override reads as "not installed", which hides its model picker
 *  rail and its MCP and Skills rows. Read here rather than threaded through
 *  six call sites, and carried in the query key so a changed override rescans. */
const providerCommands = (): Record<string, string> => {
  const { providerLaunch } = loadSettings();
  const commands: Record<string, string> = {};
  for (const [provider, launch] of Object.entries(providerLaunch)) {
    const command = launch?.command.trim();
    if (command) commands[provider] = command;
  }
  return commands;
};

/** Install + version probe for every provider CLI. Rescan on demand. One
 *  `--version` subprocess per provider, so it is refetched rarely and only
 *  where its answer is shown. */
export const useProviderStatus = (enabled = true) => {
  // Per mount, not per render: every consumer of this hook would otherwise
  // re-read localStorage on each pass. Surfaces that show it are opened fresh,
  // so an override edited mid-session is picked up the next time one opens.
  const commands = useMemo(providerCommands, []);
  return useQuery({
    queryKey: providerKeys.status(commands),
    queryFn: () => invoke<ProviderStatus[]>("provider_status", { commands }),
    enabled,
    staleTime: 5 * 60_000,
    // Six `--version` subprocesses; window focus is not new information.
    refetchOnWindowFocus: false,
    retry: false,
  });
};

// MCP servers across harness configs, for the Settings → MCP surface. The
// harness files are the source of truth, so the list is a read-back, not
// state Emberyx owns.
export const mcpKeys = {
  all: () => ["mcp", "servers"] as const,
};

export const useMcpServers = () =>
  useQuery({
    queryKey: mcpKeys.all(),
    queryFn: () => invoke<McpServerInfo[]>("mcp_list"),
    staleTime: 10_000,
    retry: false,
  });

export const invalidateMcp = (qc: QueryClient) => {
  qc.invalidateQueries({ queryKey: ["mcp"] });
};

export const useMcpAdd = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: McpAddSpec) => invoke<void>("mcp_add", { spec }),
    onSuccess: () => invalidateMcp(qc),
  });
};

export const useMcpRemove = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, harness }: { name: string; harness: McpHarness }) =>
      invoke<void>("mcp_remove", { name, harness }),
    onSuccess: () => invalidateMcp(qc),
  });
};

// Agent skills across harness skill folders, for the Settings → Skills
// surface. The folders are the source of truth and several harnesses read
// the same ones, so removal is folder-scoped, not per harness.
export const skillsKeys = {
  all: () => ["skills", "list"] as const,
};

export const useSkills = () =>
  useQuery({
    queryKey: skillsKeys.all(),
    queryFn: () => invoke<SkillInfo[]>("skills_list"),
    staleTime: 10_000,
    retry: false,
  });

export const useSkillAdd = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spec: SkillAddSpec) => invoke<void>("skills_add", { spec }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
};

export const useSkillCopy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillDir, harness }: { skillDir: string; harness: McpHarness }) =>
      invoke<void>("skills_copy", { skillDir, harness }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
};

export const useSkillRemove = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillDir: string) => invoke<void>("skills_remove", { skillDir }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
};

/** The persistent-agent daemon, if one is running. */
export interface DaemonHealth {
  ok: boolean;
  version: string;
  pid: number;
  uptimeMs: number;
  agentCount: number;
  eventCount: number;
  /** Agents with a running process, as opposed to ones the daemon merely has
   *  metadata for. The pill counts these — it is what "persistent" means. */
  liveCount: number;
  /** The daemon predates this build. Nothing restarts it automatically: that
   *  would kill the agents it is holding. */
  outdated: boolean;
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

/** One directory's listing. Shared with the tree, which asks for many at once
 *  through `useQueries` and so needs the options rather than the hook. */
export const dirEntriesQuery = (path: string) => ({
  queryKey: fileKeys.dir(path),
  queryFn: () => invoke<DirEntry[]>("list_dir", { path }),
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

/** Claude's catalog: seed until LiteLLM loads, then live pins generation-folded.
 *  Same fetch as pricing — no second network call. */
export const useClaudeModels = () => {
  const keys = useSyncExternalStore(subscribePricing, pricingCatalogIds, pricingCatalogIds);
  return useMemo(() => claudeModelEntries(claudePinsFromCatalog(keys)), [keys]);
};

/** Codex's model catalog. Account-wide, so it isn't keyed by project, and it
 *  only loads once the picker that needs it is mounted. */
export const useCodexModels = (cwd: string, enabled: boolean) =>
  useQuery({
    queryKey: codexKeys.models,
    queryFn: () => listCodexModels(cwd),
    enabled,
    staleTime: Infinity,
  });

export const acpKeys = {
  models: (provider: string, cwd: string) => ["acp", "models", provider, cwd] as const,
};

/** An ACP provider's model catalog, read from a throwaway session. Keyed by
 *  project too — OpenCode's catalog is configurable per project
 *  (opencode.json), so one project's list must not answer for another's. */
export const useAcpModels = (provider: string, cwd: string, enabled: boolean) =>
  useQuery({
    queryKey: acpKeys.models(provider, cwd),
    queryFn: () => readAcpModels(provider, cwd),
    enabled,
    staleTime: Infinity,
  });

export const usageKeys = { summary: (days: number) => ["usage", days] as const };

/** Cross-project token usage for the last `days`, one row per day/project/model. */
export const useUsageSummary = (days: number, enabled: boolean) =>
  useQuery({
    queryKey: usageKeys.summary(days),
    queryFn: () => invoke<UsageSummary>("usage_summary", { days }),
    enabled,
    staleTime: 60_000,
  });

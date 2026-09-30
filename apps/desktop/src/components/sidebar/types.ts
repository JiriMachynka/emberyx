import type { LinkedPr } from "@/lib/forge";
import type { ThreadState } from "@/lib/threadMeta";
import type { Project, Session, Thread } from "@/types";
import type { ThreadGrouping, ThreadView } from "@/lib/settings";
import type { WorkspaceTab } from "@/lib/sidebar";

export interface SidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  activeByProject: Record<string, string>;
  sessionsFor: (id: string) => Session[];
  /** Keep every project's session list open, not only the active project's. */
  expandAll: boolean;
  threadView: ThreadView;
  /** Idle days after which a thread folds into Settled; 0 = never. */
  threadSettleDays: number;
  /** Fold a thread away once its branch has been merged. */
  threadAutoSettleOnMerge: boolean;
  threadGrouping: ThreadGrouping;
  /** Chat/thread font stack, shared with the chat pane. */
  fontFamily: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** The Sessions/Explorer/Changes column is hidden; the project rail stays. */
  workspaceCollapsed: boolean;
  workspaceTab: WorkspaceTab;
  onWorkspaceTab: (tab: WorkspaceTab) => void;
  /** Open the editor overlay on an Explorer click. */
  onOpenEditor: (path?: string) => void;
  /** Open the Review dock tab from a Changes file, when the dock is on. */
  onOpenReview: () => void;
  rightDock: boolean;
  onOpenWorktree: (path: string, repoRoot: string, branch: string) => void;
  onRemoveWorktree: (worktreePath: string, repoRoot: string) => void | Promise<void>;
  /** Origin remote host, for commit/PR actions in the Changes column. */
  remoteHost: string | undefined;
  /** Column Sessions tab: the rail already names the project. */
  sessionsOnly?: boolean;
  onSelectProject: (id: string) => void;
  onCloseProject: (id: string) => void;
  onPickProject: () => void;
  onSelectSession: (projectId: string, id: string) => void;
  onResumeThread: (projectId: string, path: string, thread: Thread) => void;
  onCloseSession: (id: string) => void;
  onMoveSession: (projectId: string, from: string, to: string) => void;
  onNewAgent: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  onBackFromSettings: () => void;
}

export interface ThreadRowData {
  project: Project;
  thread: Thread;
  /** `threadMeta` store key — the identity every inbox action is keyed by. */
  key: string;
  state: ThreadState;
  /** Worktree branch, else the project's current branch. */
  branch: string | undefined;
  /** PR/MR the user linked from the transcript, if any. */
  linkedPr?: LinkedPr;
}

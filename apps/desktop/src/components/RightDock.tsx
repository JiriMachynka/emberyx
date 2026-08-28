import { Plus, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidePanel } from "@/components/SidePanel";
import { cn } from "@/lib/utils";
import { DockPicker } from "@/components/DockPicker";
import { DOCK_ICONS } from "@/lib/dockIcons";
import {
  DOCK_LABEL,
  isChooser,
  type DockKind,
  type DockState,
} from "@/lib/dock";

interface RightDockProps {
  state: DockState;
  /** What the + menu may add, in menu order. */
  available: readonly DockKind[];
  /** One node per tab, built by the owner — the dock decides what is mounted. */
  panes: Partial<Record<DockKind, React.ReactNode>>;
  onSelect: (kind: DockKind) => void;
  onClose: (kind: DockKind) => void;
  onAdd: (kind: DockKind) => void;
  /** Hide the panel without closing a tab — the chrome X, and the dock toggle. */
  onHide: () => void;
  titles?: Partial<Record<DockKind, string>>;
  unavailable?: Partial<Record<DockKind, string>>;
}

/**
 * The right-hand dock: one resizable panel holding every right-side surface as
 * a tab. Open tabs stay mounted (an inactive tab is hidden, not rebuilt);
 * closing a tab unmounts its pane, so a closed diff isn't still polling git.
 * Child processes live in lib/ptyLog, never in a pane, so unmounting is safe.
 */
export function RightDock({
  state,
  available,
  panes,
  onSelect,
  onClose,
  onAdd,
  onHide,
  titles,
  unavailable,
}: RightDockProps) {
  const { tabs, active } = state;
  const chooser = isChooser(state);
  const addable = available.filter((k) => !tabs.includes(k));

  return (
    <SidePanel
      storageKey="dock"
      open={state.open}
      flushHeader
      onClose={onHide}
      header={
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((kind) => {
            const Icon = DOCK_ICONS[kind];
            return (
            <div
              key={kind}
              className={cn(
                "group flex shrink-0 items-center gap-1 rounded-md pl-2 pr-1 py-1 text-xs transition-colors",
                kind === active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(kind)}
                className="flex max-w-32 items-center gap-1.5 truncate"
              >
                <Icon className="size-3.5 shrink-0 opacity-70" />
                <span className="truncate">{DOCK_LABEL[kind]}</span>
              </button>
              <button
                type="button"
                onClick={() => onClose(kind)}
                title={`Close ${DOCK_LABEL[kind]}`}
                className="rounded p-0.5 text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
            );
          })}
          {addable.length > 0 && !chooser && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="Open another tab"
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {addable.map((kind) => {
                  const Icon = DOCK_ICONS[kind];
                  return (
                    <DropdownMenuItem key={kind} onSelect={() => onAdd(kind)}>
                      <Icon className="size-3.5 opacity-70" />
                      {DOCK_LABEL[kind]}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      {chooser && (
        <DockPicker onPick={onAdd} titles={titles} unavailable={unavailable} />
      )}
      {tabs.map((kind) => (
        <div
          key={kind}
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            kind === active ? "" : "hidden"
          )}
        >
          {panes[kind]}
        </div>
      ))}
    </SidePanel>
  );
}

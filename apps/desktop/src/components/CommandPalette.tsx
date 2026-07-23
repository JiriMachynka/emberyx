import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import {
  CircleDollarSign,
  FileDiff,
  FolderOpen,
  History,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Terminal,
} from "lucide-react";
import { basename } from "@/lib/path";
import type { Project, Session, Thread } from "@/types";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: Session[];
  projects: Project[];
  chatUi: boolean;
  onSelectSession: (projectId: string, sessionId: string) => void;
  onResumeThread: (projectId: string, path: string, thread: Thread) => void;
  onNewAgent: () => void;
  onPickProject: () => void;
  onOpenSettings: () => void;
  onToggleChanges: () => void;
  onSearch: () => void;
  onOpenUsage: () => void;
}

/** ⌘K launcher: fuzzy-search open sessions + recent threads, or run a quick
 *  action. Keyboard-first — cmdk handles arrows/enter/filtering. */
export function CommandPalette({
  open,
  onOpenChange,
  sessions,
  projects,
  chatUi,
  onSelectSession,
  onResumeThread,
  onNewAgent,
  onPickProject,
  onOpenSettings,
  onToggleChanges,
  onSearch,
  onOpenUsage,
}: CommandPaletteProps) {
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const projectName = (id: string) => {
    const p = projects.find((x) => x.id === id);
    return p ? basename(p.path) : "";
  };

  const openSessions = sessions.filter((s) => s.kind !== "dev");

  // A thread already open as a session (chat resume, or a --resume agent) is
  // reached via the Sessions group, so don't offer to resume it again.
  const isOpen = (projectId: string, threadId: string) =>
    sessions.some(
      (s) =>
        s.projectId === projectId &&
        (s.resume === threadId || s.command?.includes(threadId))
    );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[15%] z-50 w-full max-w-lg -translate-x-1/2 px-4 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            loop
            className="overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Command.Input
                autoFocus
                placeholder="Search threads, sessions, actions…"
                className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
              <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
                No results.
              </Command.Empty>

              <Command.Group heading="Actions">
                <Item
                  value={`action new ${chatUi ? "chat" : "agent"}`}
                  onSelect={() => run(onNewAgent)}
                >
                  <Plus className="size-4 text-muted-foreground" />
                  {chatUi ? "New chat" : "New agent"}
                </Item>
                <Item value="action open project" onSelect={() => run(onPickProject)}>
                  <FolderOpen className="size-4 text-muted-foreground" />
                  Open project…
                </Item>
                <Item value="action toggle changes" onSelect={() => run(onToggleChanges)}>
                  <FileDiff className="size-4 text-muted-foreground" />
                  Toggle changes
                </Item>
                <Item value="action search in project" onSelect={() => run(onSearch)}>
                  <Search className="size-4 text-muted-foreground" />
                  Search in project
                </Item>
                <Item value="action usage cost" onSelect={() => run(onOpenUsage)}>
                  <CircleDollarSign className="size-4 text-muted-foreground" />
                  Usage & cost
                </Item>
                <Item value="action settings" onSelect={() => run(onOpenSettings)}>
                  <Settings className="size-4 text-muted-foreground" />
                  Settings
                </Item>
              </Command.Group>

              {openSessions.length > 0 && (
                <Command.Group heading="Open sessions">
                  {openSessions.map((s) => (
                    <Item
                      key={s.id}
                      value={`session ${projectName(s.projectId)} ${s.label} ${s.id}`}
                      onSelect={() => run(() => onSelectSession(s.projectId, s.id))}
                    >
                      {s.kind === "chat" ? (
                        <MessageSquare className="size-4 text-muted-foreground" />
                      ) : (
                        <Terminal className="size-4 text-muted-foreground" />
                      )}
                      <span className="truncate">{s.label}</span>
                      <span className="ml-auto shrink-0 truncate pl-2 text-xs text-muted-foreground">
                        {projectName(s.projectId)}
                      </span>
                    </Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Threads">
                {projects.flatMap((p) =>
                  [...p.threads]
                    .filter((t) => !isOpen(p.id, t.id))
                    .sort((a, b) => b.modified - a.modified)
                    .map((t) => (
                      <Item
                        key={`${p.id}:${t.id}`}
                        value={`thread ${basename(p.path)} ${t.title} ${t.id}`}
                        onSelect={() => run(() => onResumeThread(p.id, p.path, t))}
                      >
                        <History className="size-4 text-muted-foreground" />
                        <span className="truncate">{t.title}</span>
                        <span className="ml-auto shrink-0 truncate pl-2 text-xs text-muted-foreground">
                          {basename(p.path)}
                        </span>
                      </Item>
                    ))
                )}
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Item({
  value,
  onSelect,
  children,
}: {
  value: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      {children}
    </Command.Item>
  );
}

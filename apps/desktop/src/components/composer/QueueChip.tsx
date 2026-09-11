import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Forward,
  Pause,
  PencilLine,
  Play,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PromptQueue } from "@/lib/promptQueue";
import { chipTrigger } from "@/components/composer/chipStyles";

/** Runtime-owned prompt queue manager: shows queued turns and lets the user
 *  reorder, edit, delete, pause/resume, or run the next one immediately. */
export function QueueChip({ queued, queue }: { queued: number; queue: PromptQueue }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const submitEdit = (queueId: string) => {
    if (text.trim()) void queue.edit(queueId, text.trim());
    setEditing(null);
    setText("");
  };
  const runNext = () => void queue.resume().then(() => queue.runNext());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        {queue.paused ? (
          <Pause className="size-4 shrink-0 opacity-70" />
        ) : (
          <Clock className="size-4 shrink-0 opacity-70" />
        )}
        <span>{queued} queued</span>
        {queue.paused && <span className="text-xs text-amber-400">paused</span>}
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-foreground">
            Prompt queue
            {queue.paused && <span className="ml-1.5 text-amber-400">· paused</span>}
          </span>
          <div className="flex items-center gap-1">
            {queue.paused ? (
              <DropdownMenuItem
                onSelect={() => void queue.resume()}
                className="justify-between gap-3 text-xs"
              >
                <Play className="size-3" /> Resume
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => void queue.pause()}
                className="justify-between gap-3 text-xs"
              >
                <Pause className="size-3" /> Pause
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={runNext}
              className="justify-between gap-3 text-xs"
            >
              <Forward className="size-3" /> Run next now
            </DropdownMenuItem>
          </div>
        </div>
        <div className="flex max-h-56 flex-col overflow-y-auto">
          {queue.items.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Queue is empty.</div>
          )}
          {queue.items.map((p, i) => (
            <div
              key={p.queueId}
              className="flex items-start gap-1 border-b border-border/50 px-2 py-1.5 last:border-0"
            >
              {editing === p.queueId ? (
                <div className="flex flex-1 items-center gap-1">
                  <Input
                    autoFocus
                    value={text}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter") submitEdit(p.queueId);
                      if (e.key === "Escape") setEditing(null);
                    }}
                    className="h-7 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => submitEdit(p.queueId)}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    <Check className="size-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-foreground" title={p.text}>
                      {p.text}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[0.65rem] text-muted-foreground">
                        #{i + 1}
                      </span>
                      {i === 0 && !queue.paused && (
                        <span className="text-[0.65rem] text-emerald-400">next</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(p.queueId);
                        setText(p.text);
                      }}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <PencilLine className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => void queue.reorder(i, i - 1)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={i === queue.items.length - 1}
                      onClick={() => void queue.reorder(i, i + 1)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void queue.remove(p.queueId)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-red-400"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

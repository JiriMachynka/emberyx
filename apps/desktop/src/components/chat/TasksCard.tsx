import { memo, useState } from "react";
import { Check, ChevronDown, ListTodo, X } from "lucide-react";
import { currentTodo, type TodoItem } from "@/lib/toolDisplay";
import { recordTodoTimings, todoTimings } from "@/lib/todoTimings";
import { formatDuration } from "@/lib/duration";
import { cn } from "@/lib/utils";

/** Elapsed time per task, captured at status transitions so the card can show
 *  "2m 35s" / "now" without the tool payload carrying clocks. The record lives
 *  outside React (`lib/todoTimings`) because the transcript is virtualized and
 *  a card that owned it lost everything on remount. */
const useTodoTimings = (planKey: string, items: TodoItem[]) =>
  recordTodoTimings(todoTimings, planKey, items, Date.now());

export const TasksCard = memo(function TasksCard({
  items,
  planKey,
  onDismiss,
  /** Live plans ride above the composer collapsed — one line, the task in
   *  flight. A settled turn's card in the transcript has room to list. */
  collapsible = false,
}: {
  items: TodoItem[];
  /** Which plan these tasks belong to — the turn's message id. Two turns'
   *  plans must not share a clock. */
  planKey: string;
  onDismiss?: () => void;
  collapsible?: boolean;
}) {
  const timings = useTodoTimings(planKey, items);
  const [open, setOpen] = useState(!collapsible);
  const expanded = !collapsible || open;
  const done = items.filter((t) => t.status === "completed").length;
  const current = collapsible ? currentTodo(items) : null;
  const header = (
    <>
      <ListTodo className="size-4 shrink-0 text-muted-foreground" />
      {current && !expanded ? (
        <span className="min-w-0 flex-1 truncate text-left">{current.text}</span>
      ) : (
        <span className="font-medium">Tasks</span>
      )}
      <span
        className={cn(
          "shrink-0 tabular-nums text-muted-foreground",
          !collapsible && "font-medium text-foreground"
        )}
      >
        {done}/{items.length}
      </span>
      {collapsible && (
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180"
          )}
        />
      )}
    </>
  );
  return (
    <div
      className={cn(
        "chat-work-panel border",
        // Tucked behind the composer, which is why the bottom corners are
        // square: the seam is covered rather than drawn.
        // pb-6 against the composer's -mb-4 overlap: 16px of this card is
        // covered, so anything less than that clips its own last row.
        collapsible ? "rounded-t-xl border-b-0 pb-6" : "rounded-xl"
      )}
    >
      {collapsible ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            {header}
          </button>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Dismiss tasks"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-sm">
          <ListTodo className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">
            Tasks {done}/{items.length}
          </span>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Dismiss tasks"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      {/* The grid wrapper eases the list open and shut (see .task-list-clip):
          it always renders, so the animation has both ends to move between. */}
      <div className="task-list-clip" data-open={expanded}>
      <ul className="flex flex-col px-3 pb-2">
        {items.map((item, i) => {
          const t = timings.get(i);
          const elapsed =
            item.status === "in_progress"
              ? "now"
              : item.status === "completed" && t?.endedAt != null
                ? formatDuration(t.endedAt - t.startedAt)
                : undefined;
          return (
            <li key={`${i}:${item.text}`} className="flex items-start gap-2 py-1.5 text-sm">
              {item.status === "completed" ? (
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : item.status === "in_progress" ? (
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
              ) : (
                <span className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground/40" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1",
                  item.status === "completed" && "text-muted-foreground",
                )}
              >
                {item.text}
              </span>
              {elapsed && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {elapsed}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      </div>
    </div>
  );
});

/**
 * The two surfaces that replace the composer while the agent is waiting on the
 * user: the `ask_user` option picker and the tool-permission prompt. Only one
 * is ever live — two focusable surfaces competing for the same keys is what
 * made picking an option unreliable — and ChatPane owns that choice.
 */

import { useEffect, useRef, useState } from "react";
import { Check, MessageCircleQuestionMark, Wrench } from "lucide-react";
import { PermissionSummary } from "@/components/chat/ToolViews";
import { cn } from "@/lib/utils";
import type {
  PendingAsk,
  PendingPermission,
  PermissionDecision,
} from "@/hooks/useAgentChat";

export function AskPrompt({
  pending,
  onAnswer,
}: {
  pending: PendingAsk;
  onAnswer: (answer: string) => void;
}) {
  const questions = pending.questions;
  const [tab, setTab] = useState(0);
  const [active, setActive] = useState<number[]>(() => questions.map(() => 0));
  const [picked, setPicked] = useState<number[][]>(() => questions.map(() => []));
  const rowRef = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    setTab(0);
    setActive(questions.map(() => 0));
    setPicked(questions.map(() => []));
  }, [pending.id, questions]);

  const submit = (all: number[][]) => {
    const parts = questions.map((q, qi) => {
      const labels = all[qi].map((i) => q.options[i].label).join(", ");
      return questions.length === 1 ? labels : `${q.header || q.question}: ${labels}`;
    });
    onAnswer(parts.join("\n"));
  };

  /** Pick (single) or toggle (multi) an option, then advance or submit. */
  const choose = (qi: number, oi: number) => {
    setActive((a) => a.map((v, i) => (i === qi ? oi : v)));
    if (questions[qi].multiSelect) {
      setPicked((p) =>
        p.map((v, i) =>
          i === qi
            ? v.includes(oi)
              ? v.filter((x) => x !== oi)
              : [...v, oi].sort((a, b) => a - b)
            : v
        )
      );
      return;
    }
    const next = picked.map((v, i) => (i === qi ? [oi] : v));
    setPicked(next);
    const missing = next.findIndex((v) => v.length === 0);
    if (missing === -1) submit(next);
    else setTab(missing);
  };

  const confirm = () => {
    const q = questions[tab];
    if (q.multiSelect && picked[tab].length === 0) {
      choose(tab, active[tab]);
      return;
    }
    const missing = picked.findIndex((v) => v.length === 0);
    if (missing === -1) submit(picked);
    else setTab(missing);
  };

  // No dep array: re-registered each render so the handler never closes over
  // stale selection state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const q = questions[tab];
      const count = q.options.length;
      const move = (delta: number) =>
        setActive((a) => a.map((v, i) => (i === tab ? (v + delta + count) % count : v)));

      if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "ArrowRight" && questions.length > 1) {
        e.preventDefault();
        setTab((t) => (t + 1) % questions.length);
      } else if (e.key === "ArrowLeft" && questions.length > 1) {
        e.preventDefault();
        setTab((t) => (t - 1 + questions.length) % questions.length);
      } else if (e.key === " " && q.multiSelect) {
        e.preventDefault();
        choose(tab, active[tab]);
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < count) {
          e.preventDefault();
          choose(tab, idx);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    rowRef.current[active[tab]]?.scrollIntoView({ block: "nearest" });
  }, [tab, active]);

  const question = questions[tab];
  const complete = picked.every((v) => v.length > 0);

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      {questions.length > 1 && (
        <div className="mb-2 flex items-center gap-1 border-b border-border pb-2">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setTab(i)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                i === tab
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {picked[i]?.length > 0 && <Check className="size-3 text-emerald-400" />}
              {q.header || `Question ${i + 1}`}
            </button>
          ))}
          <span className="ml-auto text-[0.65rem] text-muted-foreground">←→ to switch</span>
        </div>
      )}

      <div className="mb-2 flex items-start gap-2 text-sm">
        <MessageCircleQuestionMark className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span className="font-medium">{question.question}</span>
        {questions.length === 1 && question.header && (
          <span className="ml-auto shrink-0 rounded bg-secondary px-1.5 text-[10px] text-muted-foreground">
            {question.header}
          </span>
        )}
      </div>

      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {question.options.map((o, i) => {
          const isPicked = picked[tab]?.includes(i);
          return (
            <button
              key={i}
              ref={(el) => {
                rowRef.current[i] = el;
              }}
              type="button"
              onClick={() => choose(tab, i)}
              className={cn(
                "flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
                i === active[tab]
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              <kbd
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-border font-mono text-xs",
                  isPicked ? "bg-primary text-primary-foreground" : "bg-background"
                )}
              >
                {isPicked ? "✓" : i + 1}
              </kbd>
              <span className="min-w-0">
                <span className="block text-foreground">{o.label}</span>
                {o.description && (
                  <span className="block text-xs text-muted-foreground">{o.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <p className="text-xs text-muted-foreground">
          {question.multiSelect
            ? "Space or click toggles, Enter confirms."
            : `1–${question.options.length}, ↑↓ + Enter, or click.`}
        </p>
        {(question.multiSelect || questions.length > 1) && (
          <button
            type="button"
            onClick={confirm}
            disabled={!complete}
            className={cn(
              "ml-auto rounded-lg px-3 py-1 text-xs transition-colors",
              complete
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground"
            )}
          >
            Submit
          </button>
        )}
      </div>
    </div>
  );
}

/** Permission prompt for a pending can_use_tool request. Selectable by number
 *  key, arrow keys + Enter, or mouse click. */
export function PermissionPrompt({
  pending,
  onDecide,
}: {
  pending: PendingPermission;
  onDecide: (d: PermissionDecision) => void;
}) {
  const options: { key: PermissionDecision; label: string }[] = [
    { key: "allow_once", label: "Allow once" },
    ...(pending.suggestions.length > 0
      ? [{ key: "allow_always" as const, label: "Allow always" }]
      : []),
    { key: "deny", label: "Deny" },
  ];
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [pending.requestId]);

  // Window-level, same reason as AskPrompt: focus can drift, keys shouldn't.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onDecide(options[active].key);
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < options.length) {
          e.preventDefault();
          onDecide(options[idx].key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <Wrench className="size-3.5 text-primary" />
        <span className="font-medium">{pending.toolName}</span>
        <span className="text-xs text-muted-foreground">needs permission</span>
      </div>
      <PermissionSummary toolName={pending.toolName} input={pending.input} />
      <div className="flex flex-col gap-1">
        {options.map((o, i) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onDecide(o.key)}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors",
              i === active
                ? "bg-primary/15 text-foreground"
                : "text-muted-foreground hover:bg-muted"
            )}
          >
            <kbd className="grid size-5 shrink-0 place-items-center rounded border border-border bg-background font-mono text-xs">
              {i + 1}
            </kbd>
            <span className={cn(o.key === "deny" && "text-red-400")}>
              {o.label}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Press 1–{options.length}, ↑↓ + Enter, or click.
      </p>
    </div>
  );
}

/** Put the working tree back to just before this turn ran. Shows what it will
 *  touch first — a revert that silently deletes a file the user wrote by hand
 *  is not something to find out about afterwards. */

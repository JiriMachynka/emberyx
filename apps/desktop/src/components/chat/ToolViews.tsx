/**
 * A tool call as the transcript renders it: the header row, its expandable
 * body, unified diffs for edits and syntax-highlighted output. Split out of
 * ChatPane because these are self-contained leaves — they take a ToolCall and
 * render it, and nothing about them depends on the pane around them.
 */

import { Fragment, memo, useMemo, useState } from "react";
import { diffLines } from "diff";
import { Check, ChevronRight, Loader2 } from "lucide-react";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { isFileReference } from "@/lib/fileRef";
import {
  describeResult,
  describeTool,
  stripReminders,
  type TodoItem,
  type ToolBodyPart,
} from "@/lib/toolDisplay";
import { TOOL_ICONS, TOOL_TINT } from "@/lib/toolIcons";
import { useAgentStore } from "@/lib/agentStore";
import { highlightCached } from "@/lib/highlight";
import { cn } from "@/lib/utils";
import type { ToolCall } from "@/hooks/useAgentChat";

const TODO_MARK: Record<TodoItem["status"], { mark: string; className: string }> = {
  completed: { mark: "✓", className: "text-emerald-400 line-through opacity-60" },
  in_progress: { mark: "▸", className: "text-primary" },
  pending: { mark: "○", className: "text-muted-foreground" },
};

export const ToolDiff = memo(function ToolDiff({
  before,
  after,
  lang,
  streaming = false,
}: {
  before: string;
  after: string;
  lang: string | null;
  streaming?: boolean;
}) {
  const rows = useMemo(
    () =>
      diffLines(before, after).flatMap((part, i) =>
        part.value
          .replace(/\n$/, "")
          .split("\n")
          .map((line, j) => ({
            key: `${i}-${j}`,
            sign: part.added ? "+" : part.removed ? "-" : " ",
            tint: part.added
              ? "border-emerald-500/50 bg-emerald-500/15"
              : part.removed
                ? "border-red-500/50 bg-red-500/15"
                : "border-transparent",
            html: highlightCached(line, lang, !streaming),
          }))
      ),
    [before, after, lang, streaming]
  );
  return (
    <pre className="max-h-64 overflow-auto whitespace-pre font-mono text-[0.7rem] leading-relaxed">
      <div className="w-max min-w-full">
        {rows.map((row) => (
          <div key={row.key} className={cn("flex gap-2 border-l-2 px-1", row.tint)}>
            <span className="select-none text-muted-foreground">{row.sign}</span>
            <code
              className="hljs"
              style={{ background: "transparent", padding: 0 }}
              dangerouslySetInnerHTML={{ __html: row.html }}
            />
          </div>
        ))}
      </div>
    </pre>
  );
});

/** One chunk of a tool's expanded input, rendered per part kind. */
export function ToolBody({
  part,
  streaming = false,
}: {
  part: ToolBodyPart;
  streaming?: boolean;
}) {
  const label = "label" in part && part.label && (
    <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
      {part.label}
    </div>
  );

  if (part.kind === "fields") {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.7rem]">
        {part.rows.map((row) => (
          <Fragment key={row.key}>
            <dt className="text-muted-foreground">{row.key}</dt>
            <dd className="truncate font-mono" title={row.value}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  if (part.kind === "todos") {
    return (
      <ul className="flex flex-col gap-1 text-[0.7rem]">
        {part.items.map((item, idx) => {
          const style = TODO_MARK[item.status];
          return (
            <li key={idx} className="flex gap-2">
              <span className={cn("select-none", style.className)}>{style.mark}</span>
              <span className={item.status === "completed" ? "opacity-60 line-through" : ""}>
                {item.text}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  if (part.kind === "diff") {
    return (
      <div>
        {label}
        <ToolDiff
          before={part.before}
          after={part.after}
          lang={part.lang}
          streaming={streaming}
        />
      </div>
    );
  }

  if (part.kind === "text") {
    return (
      <div>
        {label}
        <div className="max-h-64 overflow-auto whitespace-pre-wrap text-[0.7rem] leading-relaxed text-muted-foreground">
          {part.text}
        </div>
      </div>
    );
  }

  return (
    <div>
      {label}
      <ToolCode
        code={part.code}
        lang={part.lang}
        className="max-h-64 overflow-auto"
        streaming={streaming}
      />
    </div>
  );
}

export const ToolCard = memo(function ToolCard({ tool }: { tool: ToolCall }) {
  // Both parses are expensive — describeResult regexes and re-serialises
  // results that are routinely tens of KB — and neither depends on render.
  const display = useMemo(() => describeTool(tool.name, tool.input), [tool.name, tool.input]);
  const resultParts = useMemo(
    () => (tool.result != null ? describeResult(stripReminders(tool.result)) : null),
    [tool.result]
  );
  const Icon = TOOL_ICONS[display.icon];
  const running = tool.result == null;
  const expandable = display.body.length > 0 || tool.result != null;
  // Always closed until clicked. A card that auto-opened while working pushed
  // the conversation off-screen on every Bash call and shut again the moment
  // you started reading it; the shimmering label and the spinner already say
  // work is in flight, which is all the running state has to convey.
  const [override, setOverride] = useState(false);
  const isAgent = display.icon === "task";
  const open = override && expandable;

  // An agent card is a doorway to the side panel — clicking it selects the run
  // there rather than expanding a body inline. Everything else toggles inline.
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const selectedAgent = useAgentStore((s) => s.selectedAgent);
  const selected = isAgent && selectedAgent === tool.id;
  const clickable = isAgent || expandable;

  // A collapsed body would still pay full diff + highlight cost, so it is only
  // mounted while open — kept alive until the collapse transition finishes so
  // the card still animates shut.
  // Mounted during render, not in an effect, so the body exists in the same
  // commit that grows the grid row — otherwise opening snaps instead of gliding.
  const [bodyMounted, setBodyMounted] = useState(open);
  if (open && !bodyMounted) setBodyMounted(true);

  return (
    <div className="relative rounded-lg">
      <div className="overflow-hidden rounded-lg border border-border bg-card/50 text-xs">
      <button
        type="button"
        onClick={() =>
          isAgent
            ? selectAgent(selected ? null : tool.id)
            : expandable && setOverride(!open)
        }
        disabled={!clickable}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
          clickable && "hover:bg-muted/40",
          selected && "bg-primary/10"
        )}
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            tool.isError ? "text-red-400" : TOOL_TINT[display.icon]
          )}
        />
        <span className={cn("shrink-0 font-medium", running && "tool-running-label")}>
          {display.label}
        </span>
        {/* Most tool titles are the file the tool touched — say which kind. */}
        {display.title && isFileReference(display.title) && (
          <FileTypeIcon path={display.title} />
        )}
        {display.title && (
          <span
            className={cn(
              "min-w-0 truncate text-muted-foreground",
              display.mono && "font-mono text-[0.7rem]"
            )}
          >
            {display.title}
          </span>
        )}
        {display.meta && (
          <span className="shrink-0 rounded border border-border px-1.5 py-px text-[0.65rem] text-muted-foreground">
            {display.meta}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {running ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : tool.isError ? (
            <span className="text-[0.7rem] text-red-400">error</span>
          ) : (
            <Check className="size-3.5 text-emerald-400" />
          )}
          {expandable && !isAgent && (
            <ChevronRight
              className={cn(
                "size-3 text-muted-foreground transition-transform duration-200",
                open && "rotate-90"
              )}
            />
          )}
        </div>
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        onTransitionEnd={(e) => {
          if (!open && e.propertyName === "grid-template-rows") setBodyMounted(false);
        }}
      >
        <div className="overflow-hidden">
          {bodyMounted && (
            <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
              {display.body.map((part, idx) => (
                <ToolBody key={idx} part={part} streaming={running} />
              ))}
              {resultParts?.map((part, idx) => (
                <div
                  key={idx}
                  className={cn(
                    idx === 0 &&
                      display.body.length > 0 &&
                      "border-t border-border pt-2"
                  )}
                >
                  <ToolBody part={part} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
});

/** What the agent is asking to run, in the same shape the tool cards use. */
export function PermissionSummary({ toolName, input }: { toolName: string; input: unknown }) {
  const display = describeTool(toolName, input);
  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-md bg-muted/40 p-2 text-xs">
      {display.title && (
        <div className={cn("break-all", display.mono && "font-mono text-[0.7rem]")}>
          {display.title}
        </div>
      )}
      {display.meta && <div className="text-[0.65rem] text-muted-foreground">{display.meta}</div>}
      {display.body.map((part, idx) => (
        <ToolBody key={idx} part={part} />
      ))}
    </div>
  );
}

export const ToolCode = memo(function ToolCode({
  code,
  lang,
  className,
  streaming = false,
}: {
  code: string;
  lang: string | null;
  className?: string;
  streaming?: boolean;
}) {
  const html = useMemo(
    () => highlightCached(code, lang, !streaming),
    [code, lang, streaming]
  );
  return (
    <pre
      className={cn(
        "overflow-x-auto whitespace-pre-wrap font-mono text-[0.7rem]",
        className
      )}
    >
      <code
        className="hljs"
        style={{ background: "transparent", padding: 0 }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
});

/** The agent's question(s), from the ask_user tool. Replaces the composer while
 *  open. Several questions render as tabs: ←→ switches tab, ↑↓ moves the
 *  highlight, 1–9 picks, Space toggles a multi-select row, Enter confirms.
 *
 *  Keys are taken on `window` rather than from a focused container: the old
 *  focus-based contract silently dropped every keystroke once focus drifted
 *  anywhere else, which read as "the picker ignored my selection". */

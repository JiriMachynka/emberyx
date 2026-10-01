import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { FileTypeIcon } from "@/components/FileTypeIcon";
import { StepEnter, useStepQueue } from "@/components/chat/StepEnter";
import { Disclosure, DisclosureChevron } from "@/components/chat/Disclosure";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { ToolBody } from "@/components/chat/ToolViews";
import { useWorkPin } from "@/components/chat/WorkPin";
import { useAgentStore } from "@/lib/agentStore";
import {
  groupActivities,
  iconForActivity,
  isAgentActivity,
  isFileActivity,
  isMonoActivity,
  labelForActivity,
  metaForActivity,
  titleForActivity,
  visibleActivities,
  type ActivityGroup,
} from "@/lib/activityDisplay";
import { TOOL_ICONS, TOOL_TINT } from "@/lib/toolIcons";
import { useProjectCwd } from "@/components/FileRef";
import { isFileReference, relativeToProject } from "@/lib/fileRef";
import { describeResult, describeTool, stripReminders } from "@/lib/toolDisplay";
import { cn } from "@/lib/utils";
import type { ActivityItem } from "@/types";

/**
 * One row of agent work, whatever produced it.
 *
 * The header reads entirely off fields the normalizer precomputed, so a
 * collapsed row costs nothing — which matters because a long turn is a column
 * of them and only one is ever open. `describeTool` is called only for the
 * disclosure body, and only once it is actually mounted.
 */
export const ActivityRow = memo(function ActivityRow({
  activity,
}: {
  activity: ActivityItem;
  /** This row belongs to the turn still streaming. */
  live?: boolean;
}) {
  const Icon = TOOL_ICONS[iconForActivity(activity)];
  const tint = TOOL_TINT[iconForActivity(activity)];
  const label = labelForActivity(activity);
  const cwd = useProjectCwd();
  const named = titleForActivity(activity);
  // A file row says where in the project, not where on disk.
  const title =
    named && cwd && activity.displayDescription == null && isFileActivity(activity)
      ? relativeToProject(named, cwd)
      : // A command row's arguments stream in after the row appears; until they do
        // the header would be a bare verb.
        (named ?? (!activity.complete ? "Preparing…" : undefined));
  const meta = metaForActivity(activity);
  // A provider says when its work finished. The tool card had to infer it from
  // whether a result had landed, which left a tool that returns nothing
  // spinning forever.
  const running = !activity.complete;
  const isAgent = isAgentActivity(activity);
  const expandable = activity.arguments != null || activity.output != null;

  // Open while this row is the one still running; a click sticks. Auto-opening
  // every card used to bury the answer — only the in-flight one expands.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = expandable && !isAgent && (override ?? running);

  const { pin } = useWorkPin();
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const selectedAgent = useAgentStore((s) => s.selectedAgent);
  const selected = isAgent && selectedAgent === activity.id;
  const clickable = isAgent || expandable;

  // Mounted during render, not in an effect, so the body exists in the same
  // commit that grows the grid row — otherwise opening snaps instead of gliding.
  const [bodyMounted, setBodyMounted] = useState(open);
  if (open && !bodyMounted) setBodyMounted(true);

  // Both parses are expensive and neither depends on render. Gated on the body
  // being mounted so a closed row never pays for them at all.
  const bodyParts = useMemo(() => {
    if (!bodyMounted || activity.arguments == null) return [];
    try {
      return describeTool(activity.title, JSON.parse(activity.arguments)).body;
    } catch {
      // Half-streamed JSON is not an error worth showing; the header already
      // says what is running.
      return [];
    }
  }, [bodyMounted, activity.title, activity.arguments]);
  const resultParts = useMemo(
    () =>
      bodyMounted && activity.output != null
        ? describeResult(stripReminders(activity.output))
        : null,
    [bodyMounted, activity.output]
  );

  return (
    <div className="work-row group/row text-xs">
      <button
        type="button"
        aria-expanded={expandable && !isAgent ? open : undefined}
        onClick={() => {
          if (isAgent) selectAgent(selected ? null : activity.id);
          else if (expandable) {
            setOverride(!open);
            pin([activity.id]);
          }
        }}
        disabled={!clickable}
        className={cn(
          // A row on the work rail: the left padding is the rail's gutter and
          // the icon sits in a tile at its end. Square hover — these are rows
          // on a hairline now, not cards in a box.
          "flex w-full items-center gap-2 py-2 pl-8 pr-3 text-left transition-colors",
          clickable && "hover:bg-secondary",
          selected && "bg-primary/10"
        )}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border/60 bg-card/40">
          <Icon className={cn("size-3.5", activity.failed ? "text-red-400" : tint)} />
        </span>
        <span className={cn("shrink-0 font-medium", running && "tool-running-label")}>
          {label}
        </span>
        {title && isFileReference(title) && <FileTypeIcon path={title} />}
        {title && (
          <span
            className={cn(
              "min-w-0 truncate text-muted-foreground",
              isMonoActivity(activity) && "font-mono"
            )}
          >
            {title}
          </span>
        )}
        {meta && <span className="shrink-0 text-muted-foreground">{meta}</span>}
        {activity.autoApproved && (
          <span
            className="shrink-0 text-muted-foreground/70"
            title="Approved without a prompt"
          >
            auto-approved
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {!running && activity.failed && (
            <span className="text-red-400">error</span>
          )}
          {expandable && !isAgent && (
            <DisclosureChevron
              open={open}
              className={cn(
                // Quiet until the row is hovered or open: the reference tree
                // carries no per-row affordance, and seven chevrons down the
                // right edge is noise, not information.
                "text-muted-foreground duration-200",
                !open && "opacity-0 transition-opacity group-hover/row:opacity-100"
              )}
            />
          )}
        </div>
      </button>
      <Disclosure open={open} onClosed={() => setBodyMounted(false)}>
          {bodyMounted && (
            <div className="flex flex-col gap-2 pb-2 pl-16 pr-3">
              {bodyParts.map((part, idx) => (
                <ToolBody key={idx} part={part} streaming={running} />
              ))}
              {resultParts?.map((part, idx) => (
                <div
                  key={idx}
                  className={cn(
                    idx === 0 && bodyParts.length > 0 && "border-t border-border pt-2"
                  )}
                >
                  <ToolBody part={part} />
                </div>
              ))}
            </div>
          )}
      </Disclosure>
    </div>
  );
});

/**
 * A message's work, in the order it happened, as one rail of rows rather than
 * a boxed panel. Thoughts, commands and file work share the column so the
 * sequence reads as one tree — the left hairline and its elbows carry the
 * grouping the border used to. Content that is genuinely enclosed (a diff, code
 * output, the file tree) keeps its own surface inside a row's disclosure.
 *
 * Consecutive thoughts collapse into one `ThinkingBlock` row; consecutive file
 * work into a tree while live and plain rows once settled.
 */
export function ActivityList({
  activities,
  renderAgent,
  live,
  framed = true,
  continues = false,
}: {
  activities: ActivityItem[];
  /** A subagent run has a whole inline log of its own; the pane supplies it
   *  rather than this file reaching into the agent store for a second view of
   *  the same run. */
  renderAgent?: (activity: ActivityItem) => ReactNode;
  /** Live turns only keep in-flight tools (and the accumulating file tree).
   *  Settled turns render the full log. */
  live?: boolean;
  /** Draw the rail. A caller that already provides its own surface drops it. */
  framed?: boolean;
  /** More work follows in the same turn: carry the rail through this list's
   *  last row and close the gap, so the lines read as one tree. */
  continues?: boolean;
}) {
  const { pinned, pin } = useWorkPin();
  const rows = visibleActivities(activities, live === true, pinned);
  const turnFor = useStepQueue();
  // A step already on screen when the group mounted is history; only one that
  // lands later is queued. `mounted` keeps the first render from animating the
  // whole list at once.
  const seen = useRef(new Set<string>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    for (const row of rows) seen.current.add(row.id);
  });
  const isNew = (id: string) => mounted.current && !seen.current.has(id);

  if (rows.length === 0) return null;

  const groups = groupActivities(rows);

  const renderGroup = (group: ActivityGroup): ReactNode => {
    if (group.type === "reasoning") {
      const thoughts = group.activities;
      return (
        <ThinkingBlock
          text={thoughts
            .map((thought) => thought.output ?? "")
            .filter((chunk) => chunk.length > 0)
            .join("\n\n")}
          active={thoughts.some((thought) => !thought.complete)}
          timingKey={thoughts[0].id}
          onToggle={() => pin(thoughts.map((thought) => thought.id))}
        />
      );
    }
    if (group.type === "files") {
      // One row per file, named in full — a folder tree hides the path the
      // reader came for.
      return (
        <>
          {group.activities.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} live={live} />
          ))}
        </>
      );
    }
    const activity = group.activity;
    const agent = isAgentActivity(activity) ? renderAgent?.(activity) : undefined;
    return agent ? (
      <div className="work-row">{agent}</div>
    ) : (
      <ActivityRow key={activity.id} activity={activity} live={live} />
    );
  };

  return (
    <div className={cn("flex flex-col gap-1.5", continues && "-mb-2")}>
      <div
        className={cn("flex flex-col", framed && "work-rail")}
        data-continues={continues || undefined}
      >
        {groups.map((group) => {
          const id =
            group.type === "files"
              ? `files:${group.activities[0].id}`
              : group.type === "reasoning"
                ? `think:${group.activities[0].id}`
                : group.activity.id;
          return (
            <StepEnter
              key={id}
              turn={live === true && isNew(id) ? turnFor(id) : undefined}
            >
              {renderGroup(group)}
            </StepEnter>
          );
        })}
      </div>
    </div>
  );
}

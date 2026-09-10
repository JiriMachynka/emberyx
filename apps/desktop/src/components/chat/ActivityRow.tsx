import { Fragment, memo, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ActivityFileTree } from "@/components/chat/ActivityFileTree";
import { Disclosure, DisclosureChevron } from "@/components/chat/Disclosure";
import { ThinkingBlock } from "@/components/chat/ThinkingBlock";
import { ToolBody } from "@/components/chat/ToolViews";
import { useAgentStore } from "@/lib/agentStore";
import {
  groupActivities,
  iconForActivity,
  isAgentActivity,
  isMonoActivity,
  labelForActivity,
  metaForActivity,
  titleForActivity,
  visibleActivities,
} from "@/lib/activityDisplay";
import { TOOL_ICONS, TOOL_TINT } from "@/lib/toolIcons";
import { isFileReference } from "@/lib/fileRef";
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
}) {
  const Icon = TOOL_ICONS[iconForActivity(activity)];
  const tint = TOOL_TINT[iconForActivity(activity)];
  const label = labelForActivity(activity);
  const title = titleForActivity(activity);
  const meta = metaForActivity(activity);
  // A provider says when its work finished. The tool card had to infer it from
  // whether a result had landed, which left a tool that returns nothing
  // spinning forever.
  const running = !activity.complete;
  const isAgent = isAgentActivity(activity);
  const expandable = activity.arguments != null || activity.output != null;

  // Always closed until clicked. A card that auto-opened while working pushed
  // the conversation off-screen on every command and shut again the moment you
  // started reading it.
  const [override, setOverride] = useState(false);
  const open = override && expandable;

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
    <div className="text-xs">
      <button
        type="button"
        onClick={() =>
          isAgent
            ? selectAgent(selected ? null : activity.id)
            : expandable && setOverride(!open)
        }
        disabled={!clickable}
        className={cn(
          // Square, on purpose: these are rows in a divided panel, and a
          // rounded hover bg leaves notches at every seam. The panel's own
          // rounded corners clip the outermost rows.
          "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
          clickable && "hover:bg-secondary",
          selected && "bg-primary/10"
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", activity.failed ? "text-red-400" : tint)} />
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
            title="Approved by Emberyx because this session runs at full access"
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
              className="text-muted-foreground duration-200"
            />
          )}
        </div>
      </button>
      <Disclosure open={open} onClosed={() => setBodyMounted(false)}>
          {bodyMounted && (
            <div className="flex flex-col gap-2 pb-2 pl-9 pr-3">
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
 * A turn's work, in the order it happened, on one panel: hairline rows, not a
 * stack of boxes.
 *
 * Consecutive thoughts share one Think row; a turn that thought, ran
 * something, then thought again still renders two, around the work.
 */
export function ActivityList({
  activities,
  renderAgent,
  live,
  framed = true,
}: {
  activities: ActivityItem[];
  /** A subagent run has a whole inline log of its own; the pane supplies it
   *  rather than this file reaching into the agent store for a second view of
   *  the same run. */
  renderAgent?: (activity: ActivityItem) => ReactNode;
  /** Live turns hide settled tools; the finished-turn accordion keeps the log. */
  live?: boolean;
  /** The panel is this list's own surface, unless the caller already provides
   *  one around it (the pane's replay fallback wraps a thinking block and this
   *  list in the same panel). */
  framed?: boolean;
}) {
  const rows = visibleActivities(activities, live === true);
  if (rows.length === 0) return null;
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-border/50",
        framed && "chat-work-panel overflow-hidden rounded-xl border"
      )}
    >
      {groupActivities(rows).map((group) => {
        if (group.type === "files") {
          return (
            <ActivityFileTree
              key={`files:${group.activities[0].id}`}
              activities={group.activities}
            />
          );
        }
        if (group.type === "reasoning") {
          const thoughts = group.activities;
          return (
            <ThinkingBlock
              key={thoughts[0].id}
              text={thoughts
                .map((thought) => thought.output ?? "")
                .filter((chunk) => chunk.length > 0)
                .join("\n\n")}
              active={thoughts.some((thought) => !thought.complete)}
              timingKey={thoughts[0].id}
            />
          );
        }
        const activity = group.activity;
        const agent = isAgentActivity(activity) ? renderAgent?.(activity) : undefined;
        return agent ? (
          <Fragment key={activity.id}>{agent}</Fragment>
        ) : (
          <ActivityRow key={activity.id} activity={activity} />
        );
      })}
    </div>
  );
}

import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { statusOf, STATUS_META } from "@/lib/status";
import { StatusDot } from "@/components/StatusDot";
import { useAgentStore } from "@/lib/agentStore";
import type { Session } from "@/types";

/** Text status ("working" / "needs you") beside a session row, subscribed on
 *  its own like the dot. Hidden while idle. */
export const SessionStatusLabel = memo(function SessionStatusLabel({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "idle") return null;
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "shrink-0 text-[10px] font-medium uppercase tracking-wide",
        meta.text
      )}
    >
      {meta.label}
    </span>
  );
});

/** Leading bullet for a chat session: orange/amber while Claude works,
 *  otherwise a static green dot. */
export const ChatStatusBullet = memo(function ChatStatusBullet({ id }: { id: string }) {
  const status = useAgentStore((s) => statusOf(s.statuses, id));
  if (status === "working" || status === "waiting") {
    return <StatusDot status={status} />;
  }
  return <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />;
});

/** Rolled-up status for a project row: working if any of its agents is,
 *  otherwise the first agent's own status. */
export function ProjectStatusDot({
  sessions,
  className,
  hideIdle,
}: {
  sessions: Session[];
  className?: string;
  hideIdle?: boolean;
}) {
  // The chat list is derived outside the selector: the selector runs on every
  // store notification, and filtering the sessions inside it allocated an array
  // per project per agent event.
  const agents = useMemo(() => sessions.filter((x) => x.kind === "chat"), [sessions]);
  const status = useAgentStore((s) => {
    for (const agent of agents)
      if (statusOf(s.statuses, agent.id) === "working") return "working";
    return agents[0] ? statusOf(s.statuses, agents[0].id) : "idle";
  });
  if (hideIdle && status === "idle") return null;
  return <StatusDot status={status} className={className} />;
}

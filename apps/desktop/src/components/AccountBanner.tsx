import { AlertTriangle, LogIn, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { issueTitle, resetLabel } from "@/lib/accountState";
import { useAgentStore } from "@/lib/agentStore";
import { cn } from "@/lib/utils";

/** Bar for the two account-level blocks no session can recover from. Reads the
 *  issue from the store so it (not App) re-renders when one appears, and sits
 *  in the column flow so it pushes the panes down instead of covering them.
 *  A usage limit is display-only — there is nothing to retry until it lifts. */
export function AccountBanner({ onLogin }: { onLogin?: () => void }) {
  const issue = useAgentStore((s) => s.accountIssue);
  const clearAccountIssue = useAgentStore((s) => s.clearAccountIssue);
  if (!issue) return null;

  const loggedOut = issue.kind === "logged_out";
  const reset = resetLabel(issue);
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs",
        loggedOut
          ? "border-red-500/20 bg-gradient-to-b from-red-500/20 to-red-500/10 text-red-300"
          : "border-amber-500/20 bg-gradient-to-b from-amber-500/20 to-amber-500/10 text-amber-300"
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="shrink-0 font-medium">{issueTitle(issue)}</span>
      <span className="min-w-0 truncate opacity-80">{issue.message}</span>
      {reset && <span className="shrink-0 opacity-80">· {reset}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {loggedOut && onLogin && (
          <Button size="sm" onClick={onLogin}>
            <LogIn />
            Log in
          </Button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={clearAccountIssue}
          className="rounded p-1 opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

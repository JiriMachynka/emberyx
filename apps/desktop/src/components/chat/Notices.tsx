import { Gauge, LogIn, TriangleAlert, X } from "lucide-react";
import { issueTitle, resetLabel, type AccountIssue } from "@/lib/accountState";
import { quotaMessage, type QuotaAlert } from "@/lib/quota";
import { cn } from "@/lib/utils";

/** The plan window running out, said before it stops the work rather than
 *  after. `AccountNotice` explains a session that already died; this one is a
 *  warning while the session is still usable, so it is dismissible. */
export function QuotaNotice({
  alert,
  onDismiss,
}: {
  alert: QuotaAlert;
  onDismiss: () => void;
}) {
  const spent = alert.level === "exhausted";
  return (
    <div
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs",
        // The icon carries the severity; a filled status box is costume.
        spent ? "text-red-400" : "text-amber-400"
      )}
    >
      <Gauge className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 text-foreground">
        <span className="font-medium">{quotaMessage(alert)}</span>
        {alert.resets && (
          <span className="ml-1 text-muted-foreground">{alert.resets}.</span>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground opacity-70 hover:opacity-100"
        aria-label="Dismiss usage warning"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Why this session died, when it was the account rather than the work: the
 *  generic "Session ended" is indistinguishable from a clean exit. The action
 *  (logging back in) lives in the global banner, so this only explains. */
export function AccountNotice({ issue }: { issue: AccountIssue }) {
  const limited = issue.kind === "rate_limit";
  const Icon = limited ? TriangleAlert : LogIn;
  const reset = resetLabel(issue);
  return (
    <div
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs",
        limited ? "text-amber-400" : "text-red-400"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 text-foreground">
        <div className="font-medium">{issueTitle(issue)}</div>
        <div className="mt-0.5 break-words text-muted-foreground">
          {issue.message}
        </div>
        {reset && <div className="mt-0.5 text-muted-foreground">{reset}</div>}
      </div>
    </div>
  );
}

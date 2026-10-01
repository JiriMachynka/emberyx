import { useCallback } from "react";
import { issueTitle, resetLabel, type AccountIssue } from "@/lib/accountState";
import { useAgentStore } from "@/lib/agentStore";
import { notifyNative } from "@/lib/notifications";
import { basename } from "@/lib/path";
import { loadSettings } from "@/lib/settings";

/** Record an account-level failure and announce it in the generic error's
 *  place — "usage limit reached" is actionable, "ended with an error" isn't.
 *  Shared by every transport so a spent plan reads the same on each. */
export const useAccountIssue = (emberyxSessionId: string, cwd: string) => {
  const reportAccountIssue = useAgentStore((st) => st.reportAccountIssue);
  const pushNotification = useAgentStore((st) => st.pushNotification);
  return useCallback(
    (issue: AccountIssue) => {
      reportAccountIssue(emberyxSessionId, issue);
      const kind = issue.kind === "rate_limit" ? "rate-limited" : "logged-out";
      const title = issueTitle(issue);
      const reset = resetLabel(issue);
      const body = reset ? `${issue.message} — ${reset}` : issue.message;
      pushNotification({
        session: emberyxSessionId,
        project: basename(cwd),
        kind,
        title,
        body,
      });
      void notifyNative(loadSettings(), kind, title, body);
    },
    [cwd, emberyxSessionId, pushNotification, reportAccountIssue]
  );
};

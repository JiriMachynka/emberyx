/**
 * The two code-hosting services Emberyx reviews changes on.
 *
 * GitHub and GitLab answer the same questions with different nouns and
 * different endpoints. The Rust side already normalises the *shapes* (a GitHub
 * pull request arrives as a `MergeRequest`), so all that is left here is the
 * command names and the words shown to the user — which stay each service's
 * own, because calling a pull request a merge request is its own small lie.
 */

export type RemoteHost = "github" | "gitlab";

export const FORGE_LABEL: Record<RemoteHost, string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

/** What the service calls one change proposal, singular and plural. */
export const FORGE_NOUN: Record<RemoteHost, { one: string; many: string }> = {
  github: { one: "pull request", many: "Pull requests" },
  gitlab: { one: "merge request", many: "Merge requests" },
};

export interface ForgeCommands {
  hasToken: string;
  setToken: string;
  clearToken: string;
  list: string;
  detail: string;
  diff: string;
  notes: string;
}

const COMMANDS: Record<RemoteHost, ForgeCommands> = {
  github: {
    hasToken: "github_has_token",
    setToken: "github_set_token",
    clearToken: "github_clear_token",
    list: "github_prs",
    detail: "github_pr",
    diff: "github_pr_diff",
    notes: "github_pr_notes",
  },
  gitlab: {
    hasToken: "gitlab_has_token",
    setToken: "gitlab_set_token",
    clearToken: "gitlab_clear_token",
    list: "gitlab_mrs",
    detail: "gitlab_mr",
    diff: "gitlab_mr_diff",
    notes: "gitlab_mr_notes",
  },
};

export const forgeCommands = (host: RemoteHost): ForgeCommands => COMMANDS[host];

export const isRemoteHost = (value: string): value is RemoteHost =>
  value === "github" || value === "gitlab";

/**
 * A repo whose remote isn't on this service is a normal state, not a failure.
 * Both backends phrase it the same way, so one check covers them.
 */
export const isMissingRemote = (error: unknown): boolean =>
  /Not a (github|gitlab)\.com repository/.test(String(error));

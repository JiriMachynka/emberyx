import { describe, expect, it } from "vitest";
import {
  FORGE_LABEL,
  FORGE_NOUN,
  forgeCommands,
  isMissingRemote,
  isRemoteHost,
} from "@/lib/forge";

describe("forgeCommands", () => {
  it("routes every call to the service's own command", () => {
    expect(forgeCommands("github").list).toBe("github_prs");
    expect(forgeCommands("gitlab").list).toBe("gitlab_mrs");
    expect(forgeCommands("github").hasToken).toBe("github_has_token");
    expect(forgeCommands("gitlab").hasToken).toBe("gitlab_has_token");
  });

  it("covers the same surface for both", () => {
    expect(Object.keys(forgeCommands("github")).sort()).toEqual(
      Object.keys(forgeCommands("gitlab")).sort()
    );
  });
});

describe("wording", () => {
  // Calling a pull request a merge request is its own small lie.
  it("keeps each service's own noun", () => {
    expect(FORGE_NOUN.github.one).toBe("pull request");
    expect(FORGE_NOUN.gitlab.one).toBe("merge request");
    expect(FORGE_LABEL.github).toBe("GitHub");
    expect(FORGE_LABEL.gitlab).toBe("GitLab");
  });
});

describe("isRemoteHost", () => {
  it("accepts the two services and nothing else", () => {
    expect(isRemoteHost("github")).toBe(true);
    expect(isRemoteHost("gitlab")).toBe(true);
    expect(isRemoteHost("other")).toBe(false);
    expect(isRemoteHost("")).toBe(false);
  });
});

describe("isMissingRemote", () => {
  // A repo hosted elsewhere is a normal state, not a crash.
  it("recognises both services' phrasing", () => {
    expect(isMissingRemote("Not a github.com repository")).toBe(true);
    expect(isMissingRemote(new Error("Not a gitlab.com repository"))).toBe(true);
  });

  it("leaves a real failure alone", () => {
    expect(isMissingRemote("GitHub rejected the token — check it in Settings")).toBe(
      false
    );
  });
});

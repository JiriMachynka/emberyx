import { describe, expect, it } from "vitest";
import {
  FORGE_LABEL,
  FORGE_NOUN,
  forgeCommands,
  isMissingRemote,
  isRemoteHost,
  parsePrUrl,
} from "@/lib/forge";

describe("forgeCommands", () => {
  it("routes every call to the service's own command", () => {
    expect(forgeCommands("github").list).toBe("github_prs");
    expect(forgeCommands("gitlab").list).toBe("gitlab_mrs");
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
    expect(isMissingRemote("GitHub rejected the credentials — run `gh auth login`")).toBe(
      false
    );
  });
});

describe("parsePrUrl", () => {
  it("reads a GitHub pull request", () => {
    expect(parsePrUrl("https://github.com/acme/app/pull/12")).toEqual({
      host: "github",
      iid: 12,
      url: "https://github.com/acme/app/pull/12",
    });
  });

  it("reads gitlab.com and self-hosted merge requests", () => {
    expect(parsePrUrl("https://gitlab.com/acme/app/-/merge_requests/9")?.iid).toBe(9);
    expect(
      parsePrUrl("https://gitlab.example.com/g/p/merge_requests/3")
    ).toEqual({
      host: "gitlab",
      iid: 3,
      url: "https://gitlab.example.com/g/p/merge_requests/3",
    });
  });

  it("ignores issues, files, and junk", () => {
    expect(parsePrUrl("https://github.com/acme/app/issues/12")).toBeNull();
    expect(parsePrUrl("https://example.com/pull/1")).toBeNull();
    expect(parsePrUrl("not a url")).toBeNull();
  });
});

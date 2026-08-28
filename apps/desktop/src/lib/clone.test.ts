import { describe, expect, it } from "vitest";
import {
  cloneDirectoryName,
  joinCloneDest,
  parseCloneInput,
  parseHostedRepo,
} from "@/lib/clone";

describe("parseCloneInput", () => {
  it("accepts owner/repo on GitHub", () => {
    expect(parseCloneInput("acme/app", "github")).toEqual({
      kind: "github",
      repository: "acme/app",
    });
    expect(parseCloneInput("acme/app.git", "github")).toEqual({
      kind: "github",
      repository: "acme/app",
    });
  });

  it("accepts nested GitLab paths", () => {
    expect(parseCloneInput("group/sub/app", "gitlab")).toEqual({
      kind: "gitlab",
      repository: "group/sub/app",
    });
  });

  it("reads GitHub and GitLab clone URLs", () => {
    expect(parseCloneInput("https://github.com/acme/app.git", "github")).toEqual({
      kind: "github",
      repository: "acme/app",
    });
    expect(parseCloneInput("git@github.com:acme/app.git", "github")).toEqual({
      kind: "github",
      repository: "acme/app",
    });
    expect(parseCloneInput("https://gitlab.com/group/app.git", "gitlab")).toEqual({
      kind: "gitlab",
      repository: "group/app",
    });
    expect(
      parseCloneInput("https://gitlab.com/group/app/-/tree/main", "gitlab")
    ).toEqual({
      kind: "gitlab",
      repository: "group/app",
    });
  });

  it("rejects a GitLab URL in the GitHub flow", () => {
    expect(parseCloneInput("https://gitlab.com/acme/app", "github")).toBeNull();
  });

  it("rejects a three-segment GitHub shorthand", () => {
    expect(parseCloneInput("acme/app/extra", "github")).toBeNull();
  });

  it("accepts a raw git URL only in the URL flow", () => {
    expect(parseCloneInput("https://example.com/a/b.git", "url")).toEqual({
      kind: "url",
      url: "https://example.com/a/b.git",
    });
    expect(parseCloneInput("acme/app", "url")).toBeNull();
  });

  it("ignores blanks", () => {
    expect(parseCloneInput("  ", "github")).toBeNull();
  });
});

describe("parseHostedRepo", () => {
  it("keeps a non-forge URL as a raw clone URL", () => {
    expect(parseHostedRepo("https://git.example.com/a/b.git")).toEqual({
      kind: "url",
      url: "https://git.example.com/a/b.git",
    });
  });

  it("takes owner/repo from a GitHub tree URL", () => {
    expect(parseHostedRepo("https://github.com/acme/app/tree/main")).toEqual({
      kind: "github",
      repository: "acme/app",
    });
  });
});

describe("cloneDirectoryName", () => {
  it("uses the repo name, not the owner", () => {
    expect(cloneDirectoryName("acme/app")).toBe("app");
    expect(cloneDirectoryName("https://github.com/acme/app.git")).toBe("app");
    expect(cloneDirectoryName("git@gitlab.com:group/sub/app.git")).toBe("app");
  });
});

describe("joinCloneDest", () => {
  it("does not double the slash", () => {
    expect(joinCloneDest("/Users/jiri/Desktop/", "app")).toBe(
      "/Users/jiri/Desktop/app"
    );
  });
});

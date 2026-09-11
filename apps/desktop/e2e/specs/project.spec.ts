import { join } from "node:path";
import { COMPOSER_READY, displayed, sandbox, stubCalls } from "../helpers";

describe("project", () => {
  it("opens a git repo from the recent list", async () => {
    const s = sandbox();
    // The native folder picker can't be driven, so the project arrives the way
    // a returning user's does: from the recents the welcome screen lists.
    // The Claude binary is pinned to the stub as well as first on PATH.
    await browser.execute(
      (project, stub) => {
        localStorage.setItem("emberyx.recents", JSON.stringify([project]));
        localStorage.setItem(
          "emberyx.settings",
          JSON.stringify({
            agentBackend: "claude",
            persistentAgents: false,
            providerLaunch: { claude: { command: stub, args: "" } },
          })
        );
      },
      s.project,
      join(s.bin, "claude")
    );
    await browser.refresh();

    const recent = await displayed(`button[title="${s.project}"]`);
    await expect(recent).toHaveText(expect.stringContaining("e2e-project"));
    await recent.click();

    await displayed(COMPOSER_READY);
    await expect($("h1=Emberyx")).not.toBeDisplayed();
  });

  it("launched the stub agent inside the sandbox", async () => {
    const s = sandbox();
    const agentCall = () => stubCalls().find((c) => c.argv?.includes("stream-json"));
    // The composer unlocks once the spawn returns; the stub logs a beat later.
    await browser.waitUntil(() => agentCall() !== undefined, {
      timeoutMsg: "the app never launched the stub claude",
    });
    const agent = agentCall();
    expect(agent?.cwd).toBe(s.project);
    expect(agent?.home).toBe(s.home);
  });
});

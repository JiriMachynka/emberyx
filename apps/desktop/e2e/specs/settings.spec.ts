import { displayed } from "../helpers";

// Mirrors TABS in src/components/settings/tabs.ts. Listed rather than read off
// the nav so a tab that silently vanished fails here instead of being skipped.
const TABS = [
  "General",
  "Appearance",
  "Shortcuts",
  "Notifications",
  "Providers",
  "MCP",
  "Skills",
  "Connections",
  "Source Control",
  "Usage",
];

describe("settings", () => {
  before(async () => {
    await (await displayed('button[title="Settings"]')).click();
    await $("#settings-navigation nav").waitForDisplayed();
  });

  it("lists every section", async () => {
    const labels = await $$("#settings-navigation nav button").map((b) => b.getText());
    expect(labels).toEqual(TABS);
  });

  for (const label of TABS) {
    it(`mounts ${label}`, async () => {
      await $("#settings-navigation nav").$(`button=${label}`).click();
      const heading = $(`//h1[normalize-space()=${JSON.stringify(label)}]`);
      await expect(heading).toBeDisplayed();
      await expect($("[data-settings-content] > *")).toBeExisting();
    });
  }

  after(async () => {
    await (await displayed('button[title="Back"]')).click();
  });
});

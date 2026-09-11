import { displayed } from "../helpers";

// Mirrors TABS in src/components/settings/tabs.ts. Listed rather than read off
// the nav so a tab that silently vanished fails here instead of being skipped.
const TABS = [
  "General",
  "Appearance",
  "Keyboard Shortcuts",
  "Providers",
  "MCP",
  "Skills",
  "Connections",
  "Source Control",
  "Notifications",
  "About",
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
      // The heading is the page's; the section component renders after it.
      // Something there means the section itself mounted without throwing.
      await expect(heading.$("./following-sibling::*[1]")).toBeExisting();
    });
  }

  after(async () => {
    await (await displayed('button[title="Back"]')).click();
  });
});

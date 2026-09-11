import { COMPOSER_READY, byText, displayed, stubCalls } from "../helpers";

describe("chat", () => {
  it("sends a message and renders the agent's reply", async () => {
    const message = `hello e2e ${Date.now().toString(36)}`;
    const composer = await displayed(COMPOSER_READY);
    await composer.setValue(message);
    await browser.keys("Enter");

    await expect($(byText(`Stub reply to: ${message}`))).toBeDisplayed();
    // The turn settled: the composer is back to its idle prompt, empty.
    await expect(await displayed(COMPOSER_READY)).toHaveValue("");
    expect(stubCalls().some((c) => c.prompt === message)).toBe(true);
  });
});

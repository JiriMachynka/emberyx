describe("launch", () => {
  it("renders the main window's welcome screen", async () => {
    await expect(browser).toHaveTitle("Emberyx");
    await expect($("h1=Emberyx")).toBeDisplayed();
    await expect($("button*=Open project")).toBeDisplayed();
  });
});

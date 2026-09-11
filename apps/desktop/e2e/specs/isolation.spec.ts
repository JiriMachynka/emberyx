import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { sandbox } from "../helpers";

// Tauri's BaseDirectory discriminants (@tauri-apps/api/path).
const APP_DATA = 14;
const HOME = 21;

const resolveDir = (directory: number) =>
  browser.execute(
    (dir) => window.__TAURI_INTERNALS__.invoke("plugin:path|resolve_directory", { directory: dir }),
    directory
  );

describe("isolation", () => {
  it("resolves HOME and AppData inside the sandbox", async () => {
    const { home } = sandbox();
    expect(await resolveDir(HOME)).toBe(home);
    const appData = await resolveDir(APP_DATA);
    expect(appData).toBe(join(home, "Library/Application Support/com.jiri.emberyx"));
    // setup() opened the durable event log there, so it exists by now.
    expect(existsSync(join(appData, "emberyx.db"))).toBe(true);
  });

  it("keeps WebKit's localStorage in the sandbox", async () => {
    const { home } = sandbox();
    await browser.execute(() => localStorage.setItem("emberyx.e2e.marker", "1"));
    const webkit = join(home, "Library/WebKit");
    await browser.waitUntil(() => existsSync(webkit) && readdirSync(webkit).length > 0, {
      timeoutMsg: `WebKit never created its data store under ${webkit}`,
    });
  });

  it("holds no file open under the real home directory", () => {
    const port = process.env.EMBERYX_E2E_PORT ?? "4445";
    const pid = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim();
    expect(pid).toMatch(/^\d+$/);
    // -F fn: one `f<fd>` line, then one `n<name>` line per open file.
    const fields = execFileSync("lsof", ["-nP", "-p", pid, "-F", "fn"], { encoding: "utf8" }).split("\n");
    const realHome = `${userInfo().homedir}/`;
    const leaks: string[] = [];
    let fd = "";
    for (const field of fields) {
      if (field.startsWith("f")) fd = field.slice(1);
      // cwd is wherever wdio was started; txt is the binary and its dylibs.
      if (field.startsWith("n") && fd !== "cwd" && fd !== "txt" && field.slice(1).startsWith(realHome)) {
        leaks.push(`${fd} ${field.slice(1)}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});

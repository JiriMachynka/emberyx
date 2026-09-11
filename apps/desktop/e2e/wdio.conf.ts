import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TauriCapabilities } from "@wdio/tauri-service";
import { appBinary, e2eDir } from "./paths";
import { appEnv, createSandbox, sandboxAt, scrubHostEnv, stubScript } from "./sandbox";

if (!existsSync(appBinary)) {
  throw new Error(`No e2e binary at ${appBinary}. Run \`bun run e2e:build\` first.`);
}

// This file is evaluated by the launcher and again by every worker. The
// launcher builds the sandbox and publishes its path; workers inherit the env
// and reuse it, so the app and the specs agree on one directory.
scrubHostEnv();
const inherited = process.env.EMBERYX_E2E_ROOT;
const sandbox = inherited ? sandboxAt(inherited) : createSandbox();
process.env.EMBERYX_E2E_ROOT = sandbox.root;
process.env.EMBERYX_E2E_PORT ??= "4445";
const logs = join(e2eDir, "logs");

const app: TauriCapabilities = {
  browserName: "tauri",
  "tauri:options": { application: appBinary },
};

export const config: WebdriverIO.Config = {
  runner: "local",
  // One app process serves every spec (the embedded provider starts it once),
  // so the order is the story: launch → isolation → project → chat → settings.
  specs: [
    "./specs/launch.spec.ts",
    "./specs/isolation.spec.ts",
    "./specs/project.spec.ts",
    "./specs/chat.spec.ts",
    "./specs/settings.spec.ts",
  ].map((spec) => join(e2eDir, spec)),
  maxInstances: 1,
  capabilities: [app],
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "embedded",
        embeddedPort: Number(process.env.EMBERYX_E2E_PORT),
        env: appEnv(sandbox),
        captureBackendLogs: true,
        backendLogLevel: "warn",
      },
    ],
  ],
  logLevel: "warn",
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60000 },
  outputDir: logs,
  tsConfigPath: join(e2eDir, "tsconfig.json"),
  // Before every find/click the service probes window focus through
  // `tauri-plugin-wdio`'s IPC, which this app does not ship; each probe waits
  // 5s for an invoke bridge that never appears. An explicit switch to the one
  // window there is marks focus as user-chosen and turns the probe off.
  before: async () => {
    await browser.switchToWindow("main");
  },
  // A failed step leaves a screenshot beside the wdio logs (gitignored).
  afterTest: async (test, _context, { passed }) => {
    if (passed) return;
    mkdirSync(logs, { recursive: true });
    await browser.saveScreenshot(join(logs, `${test.title.replace(/\W+/g, "-")}.png`));
  },
};

// Teardown runs on process exit, not in onComplete: wdio calls the config's
// onComplete *before* the service's, so the app would still be running (and
// writing) when the sandbox went away. By exit it has been stopped.
if (!inherited) {
  process.on("exit", () => {
    // Stub agents are children of the app and exit when it closes their
    // stdin. One still alive was started by this run — stop it by PID, after
    // checking the PID still names the stub and was not reused meanwhile.
    const log = existsSync(sandbox.stubLog) ? readFileSync(sandbox.stubLog, "utf8") : "";
    const pids = new Set(
      log
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { pid: number }).pid)
    );
    for (const pid of pids) {
      const cmd = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
      if (cmd.includes(stubScript)) process.kill(pid, "SIGTERM");
    }
    if (process.env.EMBERYX_E2E_KEEP) {
      console.log(`e2e sandbox kept at ${sandbox.root}`);
    } else {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
}

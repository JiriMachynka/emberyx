/**
 * Bench: where the diff surface actually spends its time.
 *
 * Not part of the default suite — `bun run bench` runs it alone against the
 * same sandbox. It builds one large multi-file working-tree diff, opens it the
 * way a user does (dock → Review), and records click→laid-out ms plus the app
 * and WebKit RSS. The numbers land in `bench/results/react.json`, so a change
 * is judged against the same fixture instead of a feel.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPOSER_READY, displayed, sandbox } from "../helpers";
import { e2eDir } from "../paths";

/** 48 files × 400 changed lines = 19,200 changed lines — the shape the first
 *  baseline was taken on. Override with BENCH_FILES / BENCH_LINES. */
const FILES = Number(process.env.BENCH_FILES ?? 48);
const LINES = Number(process.env.BENCH_LINES ?? 400);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, HOME: sandbox().home, GIT_CONFIG_NOSYSTEM: "1" },
  });

const writeModule = (repo: string, file: string, line: (i: number) => string) => {
  const path = join(repo, file);
  mkdirSync(dirname(path), { recursive: true });
  const body = Array.from({ length: LINES }, (_, i) => line(i)).join("\n");
  writeFileSync(path, `${body}\n`);
};

/** A committed baseline, then every line rewritten — one wide working-tree diff. */
const buildFixture = () => {
  const repo = join(sandbox().root, "bench-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  for (let f = 0; f < FILES; f++) {
    writeModule(repo, `src/module-${String(f).padStart(3, "0")}.ts`, (i) => `export const v${i} = ${i};`);
  }
  git(repo, "add", "-A");
  git(
    repo,
    "-c",
    "user.name=Emberyx Bench",
    "-c",
    "user.email=bench@emberyx.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "baseline"
  );
  for (let f = 0; f < FILES; f++) {
    writeModule(repo, `src/module-${String(f).padStart(3, "0")}.ts`, (i) => `export const v${i} = ${i} + 1;`);
  }
  return repo;
};

interface Scroller {
  hosts: number;
  lines: number;
  ch: number;
  sh: number;
}

const readScroller = (): Promise<Scroller> =>
  browser.execute(() => {
    const el = document.querySelector(".pierre-diffs");
    let lines = 0;
    for (const host of document.querySelectorAll("diffs-container")) {
      const code = host.shadowRoot?.querySelector("code");
      if (code) lines += code.children.length;
    }
    return {
      hosts: document.querySelectorAll("diffs-container").length,
      lines,
      ch: el instanceof HTMLElement ? el.clientHeight : 0,
      sh: el instanceof HTMLElement ? el.scrollHeight : 0,
    };
  });

interface ProcessRow {
  pid: number;
  rssKb: number;
  comm: string;
}

const psTable = (): ProcessRow[] =>
  execFileSync("ps", ["-Ao", "pid=,rss=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m ? [{ pid: Number(m[1]), rssKb: Number(m[2]), comm: m[3] }] : [];
    });

const appPid = (): number => {
  const port = process.env.EMBERYX_E2E_PORT ?? "4445";
  const pid = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  }).trim();
  if (!/^\d+$/.test(pid)) throw new Error(`no app pid listening on ${port}`);
  return Number(pid);
};

const appRssMb = (): number => {
  const row = psTable().find((p) => p.pid === appPid());
  return row ? Math.round(row.rssKb / 1024) : 0;
};

/** WebKit helper RSS by pid. The helpers are launchd-parented and share one
 *  binary path, so they cannot be tied to an app from outside. The bench holds
 *  the set stable across the open and reports only how much the pids that
 *  existed beforehand grew — an idle other app contributes ~nothing. */
const webkitRss = (): Map<number, number> => {
  const map = new Map<number, number>();
  for (const p of psTable()) if (p.comm.includes("WebKit")) map.set(p.pid, p.rssKb);
  return map;
};

const webkitDelta = (before: Map<number, number>) => {
  let deltaMb = 0;
  const rows: { pid: number; comm: string; rssMb: number; deltaMb: number }[] = [];
  for (const p of psTable()) {
    if (!p.comm.includes("WebKit")) continue;
    const was = before.get(p.pid);
    if (was === undefined) continue;
    const delta = Math.round((p.rssKb - was) / 1024);
    if (delta === 0) continue;
    deltaMb += delta;
    rows.push({ pid: p.pid, comm: p.comm, rssMb: Math.round(p.rssKb / 1024), deltaMb: delta });
  }
  return { deltaMb, rows };
};

/** Click a button by its title, through the DOM. The app's tree is large
 *  enough that a text XPath per poll is the slowest thing in this harness. */
const clickByTitle = (title: string) =>
  browser.execute((t) => {
    const el = document.querySelector(`button[title="${t}"]`);
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  }, title);

/** The dock chooser is up when the Review card is on screen. */
const chooserReady = () =>
  browser.execute(() =>
    Array.from(document.querySelectorAll("button")).some((b) =>
      (b.textContent ?? "").includes("Review uncommitted changes")
    )
  );

describe("bench", () => {
  it("measures opening one large working-tree diff", async function () {
    // A cold machine can take far longer than the suite's default 60s.
    this.timeout(240000);
    const repo = buildFixture();

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
      repo,
      join(sandbox().bin, "claude")
    );

    const mark = Date.now();
    await browser.refresh();
    const recent = await displayed(`button[title="${repo}"]`);
    const welcomeMs = Date.now() - mark;

    await recent.click();
    await displayed(COMPOSER_READY);
    const composerReadyMs = Date.now() - mark - welcomeMs;

    await browser.waitUntil(() => clickByTitle("Open dock"), {
      timeout: 5000,
      timeoutMsg: "the dock toggle never appeared",
    });
    await browser.waitUntil(chooserReady, {
      timeout: 10000,
      timeoutMsg: "the dock never offered a surface",
    });

    // Quiescence probe: time to "the diff stopped mutating", which holds
    // whatever layout options are in play (a settled scroller height does not —
    // it moved from 2.3M px to 772k px between two option sets).
    await browser.execute(() => {
      const state = { last: performance.now(), count: 0 };
      window.__emberyxBench = state;
      const inDiff = (node: Node) => {
        const el = node instanceof Element ? node : node.parentElement;
        return el !== null && el.closest(".pierre-diffs") !== null;
      };
      new MutationObserver((records) => {
        for (const record of records) {
          if (inDiff(record.target)) {
            state.last = performance.now();
            state.count += 1;
            return;
          }
        }
      }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    });

    const webkitBefore = webkitRss();

    const t0 = Date.now();
    const clicked = await browser.execute(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) =>
        (x.textContent ?? "").includes("Review uncommitted changes")
      );
      if (!(b instanceof HTMLElement)) return false;
      b.click();
      return true;
    });
    if (!clicked) throw new Error("the Review surface was not there to open");

    await browser.waitUntil(
      async () => {
        const s = await browser.execute(() => {
          const b = window.__emberyxBench;
          const hosts = document.querySelectorAll("diffs-container").length;
          return b
            ? { idle: performance.now() - b.last, count: b.count, hosts }
            : { idle: 0, count: 0, hosts: 0 };
        });
        // Settled only with files actually mounted: a render can pause for
        // >500ms between parse and paint, and that gap is not "done".
        return s.count > 0 && s.hosts > 0 && s.idle > 500;
      },
      { interval: 100, timeout: 120000, timeoutMsg: "the diff never stopped rendering" }
    );
    const diffOpenMs = Date.now() - t0;
    const scroller = await readScroller();
    const webkit = webkitDelta(webkitBefore);

    const results = {
      fixture: { repo, files: FILES, linesPerFile: LINES, changedLines: FILES * LINES },
      welcomeMs,
      composerReadyMs,
      diffOpenMs,
      diff: scroller,
      // WebKit helpers cannot be attributed per-app from outside, so only the
      // pids that existed before the open are counted, by how much they grew.
      memoryAfterDiff: { appRssMb: appRssMb(), webkitDeltaMb: webkit.deltaMb, webkit: webkit.rows },
    };
    const out = join(e2eDir, "bench", "results", "react.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
    console.log(
      `[bench] diffOpenMs=${diffOpenMs} sh=${scroller.sh} hosts=${scroller.hosts} lines=${scroller.lines} appRss=${results.memoryAfterDiff.appRssMb}MB webkitDelta=${webkit.deltaMb}MB`
    );
  });
});

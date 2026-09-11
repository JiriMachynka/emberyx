import { existsSync, readFileSync } from "node:fs";
import { sandboxAt } from "./sandbox";

export const sandbox = () => {
  const root = process.env.EMBERYX_E2E_ROOT;
  if (!root) throw new Error("EMBERYX_E2E_ROOT is unset — run the suite through wdio.conf.ts");
  return sandboxAt(root);
};

export interface StubCall {
  pid: number;
  argv?: string[];
  home?: string;
  cwd?: string;
  prompt?: string;
}

/** Every invocation of the stub `claude` so far, oldest first. */
export const stubCalls = (): StubCall[] => {
  const { stubLog } = sandbox();
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubCall);
};

/** Panes stay mounted when hidden, so a selector can match an invisible twin.
 *  This waits for the one the user can actually see. */
export const displayed = async (selector: string) => {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const el of await $$(selector)) {
        if (await el.isDisplayed()) {
          found = el;
          return true;
        }
      }
      return false;
    },
    { timeoutMsg: `nothing visible matches ${selector}` }
  );
  if (!found) throw new Error(`nothing visible matches ${selector}`);
  return found;
};

/** The deepest element whose text contains `text` — robust to text split
 *  across spans by markdown rendering or the streaming fade-in. */
export const byText = (text: string) =>
  `//*[contains(normalize-space(.), ${JSON.stringify(text)})][not(*[contains(normalize-space(.), ${JSON.stringify(text)})])]`;

export const COMPOSER_READY =
  'textarea[placeholder="Ask for changes, send follow-ups, or attach images"]';

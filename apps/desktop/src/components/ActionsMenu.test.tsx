import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ActionsMenu } from "@/components/ActionsMenu";
import type { ProjectAction } from "@/lib/actions";

// React only batches through act() when it knows it's in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTION: ProjectAction = {
  id: "a1",
  name: "Dev",
  command: "bun dev",
  runOnWorktreeCreate: false,
  openPreviewOnRun: false,
};

/** Fire the sequence a real pointer produces, in order. Radix menu items
 *  select on `pointerup`, so a test that only clicks proves nothing. */
const pressLikeAMouse = async (el: Element) => {
  for (const type of ["pointerdown", "pointerup", "click"]) {
    await act(async () => {
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
      );
    });
  }
};

const mount = async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const calls = { ran: [] as ProjectAction[], edited: [] as ProjectAction[] };
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ActionsMenu
        actions={[ACTION]}
        running={false}
        onRun={(a) => calls.ran.push(a)}
        onEdit={(a) => calls.edited.push(a)}
        onAdd={() => {}}
        onStop={() => {}}
      />
    );
  });
  // Open the menu with the keyboard: Radix's pointer path checks fields a
  // synthesised pointer event doesn't carry, and the menu only has to be open
  // for this test — how it opened isn't what is under test.
  const trigger = container.querySelector("button");
  await act(async () => {
    trigger?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
  });
  return {
    calls,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

const byTitle = (title: string) => document.body.querySelector(`[title="${title}"]`);

describe("ActionsMenu", () => {
  it("edits an action without also running it", async () => {
    const { calls, cleanup } = await mount();
    const pencil = byTitle("Edit action");
    expect(pencil).not.toBeNull();
    await pressLikeAMouse(pencil!);
    expect(calls.edited.map((a) => a.id)).toEqual(["a1"]);
    // The bug: the menu item selects on pointerup, so the pencil started the
    // action as well as opening its editor.
    expect(calls.ran).toEqual([]);
    cleanup();
  });
});

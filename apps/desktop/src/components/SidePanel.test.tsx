import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { SidePanel } from "@/components/SidePanel";
import { setPanelWidth } from "@/lib/panels";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  setPanelWidth("test", 400);
});

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const mount = () => {
  const view = render(
    <div className="flex">
      <main data-testid="beside" />
      <SidePanel storageKey="test" onClose={() => {}}>
        body
      </SidePanel>
    </div>
  );
  const beside = view.getByTestId("beside");
  const aside = view.container.querySelector("aside")!;
  const handle = view.getByTitle("Drag to resize");
  return { beside, aside, handle };
};

describe("SidePanel drag", () => {
  it("grows over the pane beside it, which holds its width until release", async () => {
    const { beside, aside, handle } = mount();
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 450 });
    await frame();

    expect(aside.style.width).toBe("450px");
    expect(beside.style.flex).not.toBe("");
    expect(beside.style.width).not.toBe("");
    expect(beside.style.marginRight).toBe("-50px");
    expect(aside.style.boxShadow).toBe("");
  });

  it("paints the strip it uncovers when it shrinks", async () => {
    const { beside, aside, handle } = mount();
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 560 });
    await frame();

    expect(aside.style.width).toBe("340px");
    expect(beside.style.marginRight).toBe("60px");
    expect(aside.style.boxShadow).toContain("-60px");
  });

  it("hands the pane back and remembers the width on release", async () => {
    const { beside, aside, handle } = mount();
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 560 });
    await frame();
    act(() => {
      fireEvent.mouseUp(window);
    });

    expect(aside.style.width).toBe("340px");
    expect(aside.style.boxShadow).toBe("");
    expect(beside.style.flex).toBe("");
    expect(beside.style.width).toBe("");
    expect(beside.style.marginRight).toBe("");
    expect(document.body.style.cursor).toBe("");
    expect(localStorage.getItem("emberyx.panel.test.width")).toBe("340");
  });

  it("never drags narrower than the minimum", async () => {
    const { aside, handle } = mount();
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 2000 });
    act(() => {
      fireEvent.mouseUp(window);
    });
    expect(aside.style.width).toBe("280px");
  });
});

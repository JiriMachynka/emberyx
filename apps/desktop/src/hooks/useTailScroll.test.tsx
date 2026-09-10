import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useTailScroll } from "@/hooks/useTailScroll";

const Box = ({ follow, text }: { follow: boolean; text: string }) => {
  const tail = useTailScroll<HTMLDivElement>(follow, text);
  return (
    <div data-testid="box" ref={tail.ref} onScroll={tail.onScroll}>
      {text}
    </div>
  );
};

// happy-dom does no layout, so the box's geometry is stubbed: a 100px window
// over content whose height the test controls.
const geometry = (el: HTMLElement) => {
  const state = { height: 100, top: 0 };
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = Math.min(v, state.height - 100);
    },
  });
  return state;
};

describe("useTailScroll", () => {
  afterEach(cleanup);

  it("follows new content to the end while streaming", () => {
    const { getByTestId, rerender } = render(<Box follow text="a" />);
    const state = geometry(getByTestId("box"));
    state.height = 600;
    rerender(<Box follow text="ab" />);
    expect(state.top).toBe(500);
    state.height = 900;
    rerender(<Box follow text="abc" />);
    expect(state.top).toBe(800);
  });

  it("lets go once the user scrolls up, and picks up again at the end", () => {
    const { getByTestId, rerender } = render(<Box follow text="a" />);
    const box = getByTestId("box");
    const state = geometry(box);
    state.height = 600;
    rerender(<Box follow text="ab" />);

    state.top = 200;
    fireEvent.scroll(box);
    state.height = 900;
    rerender(<Box follow text="abc" />);
    expect(state.top).toBe(200);

    state.top = 800;
    fireEvent.scroll(box);
    state.height = 1200;
    rerender(<Box follow text="abcd" />);
    expect(state.top).toBe(1100);
  });

  it("leaves a settled box where it is", () => {
    const { getByTestId, rerender } = render(<Box follow={false} text="a" />);
    const state = geometry(getByTestId("box"));
    state.height = 600;
    rerender(<Box follow={false} text="ab" />);
    expect(state.top).toBe(0);
  });
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StepEnter, useStepQueue } from "@/components/chat/StepEnter";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A burst of arriving steps, queued the way ActivityList queues them. */
function Burst({ ids }: { ids: string[] }) {
  const turnFor = useStepQueue();
  return (
    <div>
      {ids.map((id) => (
        <StepEnter key={id} turn={turnFor(id)}>
          {id}
        </StepEnter>
      ))}
    </div>
  );
}

const shown = () =>
  [...container.querySelectorAll(".step-enter")].map((el) => el.textContent);

it("paces a burst so each step enters after the one before it", () => {
  act(() => root.render(<Burst ids={["a", "b", "c"]} />));

  // Only the first has no wait; the rest queue.
  expect(shown()).toEqual(["a"]);

  act(() => vi.advanceTimersByTime(480));
  expect(shown()).toEqual(["a", "b"]);

  act(() => vi.advanceTimersByTime(480));
  expect(shown()).toEqual(["a", "b", "c"]);
});

it("renders a step with no turn at once, unanimated", () => {
  act(() => root.render(<StepEnter turn={undefined}>settled</StepEnter>));
  expect(container.textContent).toBe("settled");
  expect(
    container.querySelector(".step-enter")?.getAttribute("data-entering")
  ).toBeNull();
});

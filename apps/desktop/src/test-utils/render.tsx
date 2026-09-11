import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";

/** A fresh client per mount: the app's shared `queryClient` would carry one
 *  test's cached replies into the next. No retries, so a stubbed command that
 *  rejects settles on the first attempt instead of backing off for seconds. */
export const testQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** Render under a QueryClientProvider — every pane below reads through React
 *  Query. `rerender` keeps the same client so cached data survives it. */
export const renderWithQuery = (ui: ReactElement, client = testQueryClient()) => {
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return {
    ...view,
    client,
    rerender: (next: ReactElement) =>
      view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
  };
};

/** Let queued promises (stubbed `invoke` replies, React Query fetches) land. */
export const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Open a Radix menu/select trigger from the keyboard. Radix's pointer path
 *  checks fields a synthesised pointer event doesn't carry; the keyboard path
 *  is the same open, and which input opened it is never what is under test. */
export const openFromKeyboard = (trigger: Element, key = "Enter") => {
  fireEvent.keyDown(trigger, { key });
};

/** The pointer sequence a real mouse produces, in order. Radix menu items
 *  select on `pointerup`, so a test that only clicks proves nothing there. */
export const pressLikeAMouse = async (el: Element) => {
  for (const type of ["pointerdown", "pointerup", "click"]) {
    await act(async () => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    });
  }
};

/** Pin every element's layout box, for the virtualized lists: happy-dom does no
 *  layout, so a scroller measures 0×0 and the virtualizer renders nothing past
 *  its overscan. Returns the undo. */
export const stubLayout = (height = 4000, width = 1200) => {
  const proto = HTMLElement.prototype;
  const saved = (["offsetHeight", "offsetWidth", "clientHeight", "clientWidth"] as const).map(
    (prop) => [prop, Object.getOwnPropertyDescriptor(proto, prop)] as const
  );
  const savedRect = proto.getBoundingClientRect;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => height });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => height });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => width });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => width });
  proto.getBoundingClientRect = () => new DOMRect(0, 0, width, height);
  return () => {
    for (const [prop, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, prop, descriptor);
      else Reflect.deleteProperty(proto, prop);
    }
    proto.getBoundingClientRect = savedRect;
  };
};

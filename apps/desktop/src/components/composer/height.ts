/** Floor so a measure taken while the pane is `display: none` (scrollHeight
 *  0) cannot collapse the box. Cap matches `max-h-40`. */
export const clampComposerHeight = (
  scrollHeight: number,
  minLine: number,
  cap = 160
) => Math.min(Math.max(scrollHeight, minLine), cap);

/** One line of padding + text, from the textarea's computed box. */
export const minComposerLine = (el: HTMLTextAreaElement): number => {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  const line = Number.isFinite(lh) && lh > 0 ? lh : 24;
  const pad =
    (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return pad + line;
};

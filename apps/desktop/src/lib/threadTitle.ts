/** A thread title longer than this stops being a label. */
export const TITLE_MAX = 80;

/** First line that can be a sidebar label: skip blanks and markdown fences,
 *  strip a leading heading mark. ACP has no title notification, so the
 *  opening prompt is the name — and a prompt that starts ` ```javascript `
 *  is a pasted block, not a title. */
export const threadTitleFrom = (text: string): string => {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("```")) continue;
    const withoutHeading = line.replace(/^#+\s*/, "").trim();
    if (!withoutHeading) continue;
    return withoutHeading.slice(0, TITLE_MAX);
  }
  return "";
};

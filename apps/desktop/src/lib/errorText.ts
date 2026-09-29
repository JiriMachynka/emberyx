/** The one place that accepts `unknown`: a `catch` variable is `unknown` to the
 *  compiler, so nothing narrower can be handed a caught value. */
export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Streamdown's code-highlighter plugin adapter. Colouring itself lives in
 * `lib/lexer.ts`; this file is the Shiki-shaped TokensResult Streamdown
 * already knows how to paint, returned synchronously so a fence never
 * flashes plain text waiting on a grammar.
 */
import type { TokensResult } from "shiki/core";
import { highlightToTokens, resolveLang, supportedLanguages } from "@/lib/lexer";

export { resolveLang, supportedLanguages };

export interface HighlightRequest {
  code: string;
  language: string;
}

/** Tokens already computed for this fence. Highlighting is sync, so this is
 *  the same as `highlightTokens` — kept so the streaming plugin can peek
 *  without a callback. */
export const peekTokens = (code: string, language: string): TokensResult =>
  highlightToTokens(code, language);

export const highlightTokens = (
  { code, language }: HighlightRequest,
  callback?: (result: TokensResult) => void
): TokensResult => {
  const result = highlightToTokens(code, language);
  callback?.(result);
  return result;
};

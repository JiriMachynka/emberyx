import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { code, type CodeHighlighterPlugin } from "@streamdown/code";

/** T3 skips the Shiki LRU while a fence is still growing so every token
 *  doesn't write a unique partial into the cache. We go one step further:
 *  don't run Shiki until the fence has been quiet for ~80ms. The chat hook
 *  already coalesces tokens to rAF; re-highlighting a 200-line dump every
 *  frame is still quadratic. Closed fences settle and color in; the live
 *  tail stays plain until it does. */
const deferredHighlight = new Map<string, ReturnType<typeof setTimeout>>();

const deferredCode: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage(language) {
    return code.supportsLanguage(language);
  },
  getSupportedLanguages() {
    return code.getSupportedLanguages();
  },
  getThemes() {
    return code.getThemes();
  },
  highlight(options, callback) {
    const key = `${options.language}:${options.code.slice(0, 80)}`;
    const prev = deferredHighlight.get(key);
    if (prev !== undefined) clearTimeout(prev);
    deferredHighlight.set(
      key,
      setTimeout(() => {
        deferredHighlight.delete(key);
        const result = code.highlight(options, callback);
        if (result) callback?.(result);
      }, 80),
    );
    return null;
  },
};

const streamingPlugins = { code: deferredCode };
const staticPlugins = { code };

const components = {
  a({ children, href, ...rest }: ComponentProps<"a">) {
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
};

const controls = {
  code: { copy: true, download: false as const },
  table: false,
  mermaid: false,
  image: false,
};

/** Renders assistant markdown with GFM. Incomplete tokens are healed while
 *  `streaming` so a half-open fence already looks like a code block. */
export const Markdown = memo(function Markdown({
  text,
  fontSize,
  streaming = false,
}: {
  text: string;
  fontSize: number;
  streaming?: boolean;
}) {
  return (
    <div style={{ fontSize: `${fontSize}px` }}>
      <Streamdown
        className="chat-md leading-relaxed"
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        parseIncompleteMarkdown
        skipHtml
        lineNumbers={false}
        codeBlockMaxHeight={0}
        linkSafety={{ enabled: false }}
        controls={controls}
        plugins={streaming ? streamingPlugins : staticPlugins}
        components={components}
      >
        {text}
      </Streamdown>
    </div>
  );
});

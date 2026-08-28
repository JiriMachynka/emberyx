import { memo, type ComponentProps } from "react";
import { Streamdown, type ThemeInput } from "streamdown";
import { code, type CodeHighlighterPlugin } from "@streamdown/code";
import { FileRef } from "@/components/FileRef";
import { PrLink } from "@/components/PrLink";
import { fileRefPath, isFileReference } from "@/lib/fileRef";
import { cn } from "@/lib/utils";

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

/** Both slots take the same dark theme. Streamdown picks its dark colors
 *  behind a `dark:` variant, and nothing in this app ever sets the `dark`
 *  class — the window is dark, full stop — so the light slot is the one that
 *  actually paints. Pairing it with a light theme is what put GitHub-light's
 *  blues and reds on the plum canvas. Vesper is warm and low-saturation, which
 *  is the same family as the ember accent. */
const shikiTheme: [ThemeInput, ThemeInput] = ["vesper", "vesper"];

const streamingPlugins = { code: deferredCode };
const staticPlugins = { code };

const components = {
  /** Streamdown routes only inline spans here, so fences keep their own
   *  renderer. An inline span that names a file gets the file's icon. */
  inlineCode({ children, className, ...rest }: ComponentProps<"code">) {
    const text = typeof children === "string" ? children : null;
    if (text !== null && isFileReference(text)) {
      return <FileRef path={fileRefPath(text)} label={text} />;
    }
    return (
      <code
        {...rest}
        className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
      >
        {children}
      </code>
    );
  },
  a({ children, href, ...rest }: ComponentProps<"a">) {
    return (
      <PrLink href={href} {...rest}>
        {children}
      </PrLink>
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
        shikiTheme={shikiTheme}
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

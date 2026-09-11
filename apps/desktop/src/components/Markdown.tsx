import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import type { CodeHighlighterPlugin, HighlightOptions, ThemeInput } from "streamdown";
import { highlightTokens, supportedLanguages } from "@/lib/codeHighlighter";

/** Streamdown types the result inline rather than exporting it. */
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
import { FileRef } from "@/components/FileRef";
import { PrLink } from "@/components/PrLink";
import { fileRefPath, isFileReference } from "@/lib/fileRef";
import { cn } from "@/lib/utils";

/** Both slots take the same dark theme. Streamdown picks its dark colors
 *  behind a `dark:` variant, and nothing in this app ever sets the `dark`
 *  class — the window is dark, full stop — so the light slot is the one that
 *  actually paints. Pairing it with a light theme is what put GitHub-light's
 *  blues and reds on the plum canvas. Vesper is warm and low-saturation, which
 *  is the same family as the ember accent. The plugin still reports the name
 *  Streamdown expects; the tokens come from the Lezer lexer, not Shiki. */
const shikiTheme: [ThemeInput, ThemeInput] = ["vesper", "vesper"];

const lexerPlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage(language) {
    return supportedLanguages().includes(language.trim().toLowerCase());
  },
  getSupportedLanguages() {
    return supportedLanguages();
  },
  getThemes() {
    return shikiTheme;
  },
  highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void) {
    return highlightTokens({ code: options.code, language: options.language }, callback);
  },
};

const staticPlugins = { code: lexerPlugin };

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

/** Paint-only dissolve on newly mounted words. Stagger is off so a batch of
 *  tokens fades as one veil, not a cascade; duration sits in the 150–250ms
 *  enter range. Settled turns pass `false` so the spans never ship. */
const streamAnimate = {
  animation: "fadeIn" as const,
  duration: 200,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  stagger: 0,
};

/** Renders assistant markdown with GFM. `streaming` uses Streamdown's
 *  block-memoized mode so settled paragraphs don't reparse as tokens
 *  arrive; incomplete markers are closed by remend until the real ones land. */
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
        animated={streaming ? streamAnimate : false}
        isAnimating={streaming}
        parseIncompleteMarkdown
        skipHtml
        lineNumbers={false}
        codeBlockMaxHeight={0}
        shikiTheme={shikiTheme}
        linkSafety={{ enabled: false }}
        controls={controls}
        plugins={staticPlugins}
        components={components}
      >
        {text}
      </Streamdown>
    </div>
  );
});

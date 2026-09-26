import { memo, useMemo, useRef, useState, type ComponentProps } from "react";
import { Markdown as TanStackMarkdown, type MarkdownComponents } from "@tanstack/markdown/react";
import type { CodeHighlighter } from "@tanstack/markdown";
import { streamingMarkdownExtension } from "@tanstack/markdown/extensions/streaming";
import { Check, Copy } from "lucide-react";
import { FileRef } from "@/components/FileRef";
import { PrLink } from "@/components/PrLink";
import { fileRefPath, isFileReference } from "@/lib/fileRef";
import { highlightToHtml } from "@/lib/lexer";
import { liveMarkdown } from "@/lib/liveMarkdown";
import { usePacedText, useWordFading } from "@/lib/pacedText";
import { wordFadeExtension } from "@/lib/wordFadeExtension";
import { cn } from "@/lib/utils";

const streamingExtensions = [streamingMarkdownExtension()];

/** Inner token HTML only — TanStack Markdown owns the pre/code frame. */
const highlightCode: CodeHighlighter = (code, lang) =>
  highlightToHtml(code, lang ?? "text");

function Fence({
  children,
  className,
  ...rest
}: ComponentProps<"pre"> & { "data-lang"?: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const langAttr = rest["data-lang"];
  // "text" and "plaintext" name a language that isn't one — the tag is noise,
  // and the header shows the copy affordance alone.
  const lang =
    langAttr && langAttr !== "plaintext" && langAttr !== "text" ? langAttr : "";

  const copy = () => {
    const text = preRef.current?.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="md-fence">
      <div className="md-fence-header" data-language={lang || undefined}>
        {lang ? <span>{lang}</span> : null}
        <button
          type="button"
          onClick={copy}
          title="Copy code"
          className="ml-auto rounded-md p-1 text-muted-foreground outline-none transition-colors hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <pre ref={preRef} className={className} {...rest}>
        {children}
      </pre>
    </div>
  );
}

const components = {
  pre: Fence,
  /** Inline spans only: fence `code` arrives with highlighted HTML, not a string. */
  code({ children, className, ...rest }: ComponentProps<"code">) {
    if ("dangerouslySetInnerHTML" in rest) {
      return <code className={className} {...rest} />;
    }
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
  img: () => null,
} satisfies MarkdownComponents;

/** Assistant markdown. Incomplete markers stay closed while they stream and
 *  after Stop cuts them off; the streaming extension hides empty trailing
 *  headings/quotes/list items. `streaming` is the live caret, not the repair.
 *  Colouring is the Lezer lexer, same tree as the editor. */
export const Markdown = memo(function Markdown({
  text,
  fontSize,
  streaming = false,
}: {
  text: string;
  fontSize: number;
  streaming?: boolean;
}) {
  // Streamed prose is let out a word at a time, each word fading as it lands.
  const paced = usePacedText(text, streaming);
  const shown = paced.text;
  const fading = useWordFading(streaming || paced.revealing);
  const { source, incomplete } = liveMarkdown(shown);
  const repairing = streaming || incomplete;
  const extensions = useMemo(() => {
    if (!fading) return repairing ? streamingExtensions : undefined;
    return repairing
      ? [wordFadeExtension(), ...streamingExtensions]
      : [wordFadeExtension()];
  }, [fading, repairing]);
  return (
    <div
      className={cn("chat-md leading-relaxed", fading && "word-fading")}
      data-streaming={streaming ? "" : undefined}
      style={{ fontSize: `${fontSize}px` }}
    >
      <TanStackMarkdown
        frontmatter={false}
        headingIds={false}
        highlighter={highlightCode}
        extensions={extensions}
        components={components}
      >
        {repairing ? source : shown}
      </TanStackMarkdown>
    </div>
  );
});

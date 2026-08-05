import { Children, isValidElement, memo, type ReactNode } from "react";
import { MarkdownClient } from "@comark/react";
import { highlightCode, langFromName } from "@/lib/highlight";

/** The source text of a fence, off the `code` element comark renders inside `pre`. */
function fencedCode(children: ReactNode): string | null {
  const [only] = Children.toArray(children);
  if (!isValidElement<{ children?: ReactNode }>(only)) return null;
  const text = only.props.children;
  return typeof text === "string" ? text : null;
}

// Comark skips custom-component resolution for anything inside `pre`, so the
// inline branch can't swallow a fence the way react-markdown's did.
const components = {
  code({ children }: { children?: ReactNode }) {
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    );
  },
  pre({ children, language }: { children?: ReactNode; language?: string }) {
    const code = fencedCode(children);
    return (
      <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-card/60 p-3 font-mono text-[0.85em]">
        {code !== null ? (
          <code
            className="hljs"
            dangerouslySetInnerHTML={{
              __html: highlightCode(code, language ? langFromName(language) : null),
            }}
          />
        ) : (
          children
        )}
      </pre>
    );
  },
  a({ children, href }: { children?: ReactNode; href?: string }) {
    return (
      <a
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

// Raw HTML in agent output stays inert text — comark parses it into live
// elements otherwise, which react-markdown never did.
const parserOptions = { html: false };

/** Renders assistant markdown with GFM + highlight.js code blocks. */
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
    // `chat-md` goes on comark's own wrapper so its `> :first-child` rules
    // still reach the rendered blocks.
    <div style={{ fontSize: `${fontSize}px` }}>
      <MarkdownClient
        value={text}
        options={parserOptions}
        components={components}
        streaming={streaming}
        className="chat-md leading-relaxed"
      />
    </div>
  );
});

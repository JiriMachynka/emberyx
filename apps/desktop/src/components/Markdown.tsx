import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode, langFromName } from "@/lib/highlight";

/** Renders assistant markdown with GFM + highlight.js code blocks. */
export const Markdown = memo(function Markdown({
  text,
  fontSize,
}: {
  text: string;
  fontSize: number;
}) {
  return (
    <div className="chat-md leading-relaxed" style={{ fontSize: `${fontSize}px` }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className ?? "");
            const raw = String(children).replace(/\n$/, "");
            if (!match) {
              return (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                  {children}
                </code>
              );
            }
            const lang = langFromName(match[1]);
            return (
              <code
                className="hljs"
                dangerouslySetInnerHTML={{ __html: highlightCode(raw, lang) }}
              />
            );
          },
          pre({ children }) {
            return (
              <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-card/60 p-3 font-mono text-[0.85em]">
                {children}
              </pre>
            );
          },
          a({ children, href }) {
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

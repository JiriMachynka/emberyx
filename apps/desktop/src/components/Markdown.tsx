import { memo } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode, langFromName } from "@/lib/highlight";

/** The source text and language of a `<pre><code>` fence, off its hast node. */
function fencedCode(
  node: ExtraProps["node"]
): { code: string; lang: string | null } | null {
  const el = node?.children.find((c) => c.type === "element" && c.tagName === "code");
  if (!el || el.type !== "element") return null;
  const names = el.properties?.className;
  const className = Array.isArray(names) ? names.join(" ") : String(names ?? "");
  const match = /language-(\w+)/.exec(className);
  const code = el.children
    .map((c) => (c.type === "text" ? c.value : ""))
    .join("")
    .replace(/\n$/, "");
  return { code, lang: match ? langFromName(match[1]) : null };
}

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
          // Only inline code reaches this — `pre` renders fenced blocks itself.
          code({ children }) {
            return (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          // Highlight the fenced block from the hast node rather than rendering
          // the nested `code` child: a fence with no language would otherwise
          // fall through to the inline branch and paint a grey pill per line.
          pre({ node, children }) {
            const block = fencedCode(node);
            return (
              <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-card/60 p-3 font-mono text-[0.85em]">
                {block ? (
                  <code
                    className="hljs"
                    dangerouslySetInnerHTML={{
                      __html: highlightCode(block.code, block.lang),
                    }}
                  />
                ) : (
                  children
                )}
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

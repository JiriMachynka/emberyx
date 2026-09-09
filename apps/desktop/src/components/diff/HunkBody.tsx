import { DiffLine, type Highlighter } from "@/components/diff/DiffLine";
import { useHighlightVersion } from "@/lib/highlight";

/** True for unified-diff header lines that aren't source code. */
export function isDiffMeta(line: string): boolean {
  return (
    line.startsWith("@@") ||
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ")
  );
}

/** The body of one hunk, syntax-highlighted line by line. */
export function HunkBody({
  text,
  lang,
  highlight,
}: {
  text: string;
  lang: string | null;
  highlight: Highlighter;
}) {
  // Repaint once the highlight engine's chunk lands — until then `highlight`
  // answers with escaped plain text.
  useHighlightVersion();
  return (
    <>
      {text.split("\n").map((line, i) => {
        if (line === "")
          return (
            <div key={i} className="border-l-2 border-transparent pl-5">
              {" "}
            </div>
          );
        if (isDiffMeta(line)) {
          return (
            <div
              key={i}
              className="border-l-2 border-transparent pl-5 pr-2 text-muted-foreground"
            >
              {line}
            </div>
          );
        }
        const c = line[0];
        const tint =
          c === "+"
            ? "border-emerald-500/50 bg-emerald-500/15"
            : c === "-"
              ? "border-red-500/50 bg-red-500/15"
              : "";
        return (
          <DiffLine
            key={i}
            marker={c === "+" || c === "-" ? c : " "}
            code={line.slice(1)}
            lang={lang}
            tint={tint}
            highlight={highlight}
          />
        );
      })}
    </>
  );
}

import type { Hover } from "@/hooks/useSymbolHover";

/** Floating definition card: where the symbol is defined, plus its declaration
 *  rendered by shiki. Flips above the pointer in the lower half of the window. */
export function HoverCard({
  hover,
  projectPath,
  onJump,
}: {
  hover: Hover;
  projectPath: string;
  onJump: () => void;
}) {
  const above = hover.y > window.innerHeight * 0.6;
  return (
    <div
      style={{
        left: Math.min(hover.x, Math.max(8, window.innerWidth - 560)),
        top: above ? hover.y - 12 : hover.y + 18,
        transform: above ? "translateY(-100%)" : undefined,
      }}
      className="pointer-events-auto fixed z-30 max-h-80 w-[34rem] max-w-[80vw] overflow-auto rounded-md border bg-popover shadow-xl"
    >
      <button
        onClick={onJump}
        className="flex w-full items-center justify-between gap-2 border-b px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
        title="Go to definition"
      >
        <span className="truncate">
          {hover.info.path.replace(projectPath + "/", "")}:{hover.info.line}
        </span>
        {hover.info.others > 0 && (
          <span className="shrink-0">+{hover.info.others} more</span>
        )}
      </button>
      <div
        className="overflow-x-auto p-2 font-mono text-xs [&_pre]:m-0 [&_pre]:!bg-transparent"
        dangerouslySetInnerHTML={{ __html: hover.html }}
      />
    </div>
  );
}

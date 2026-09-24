import { createContext, useContext, useState } from "react";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { LinkChip } from "@/components/LinkChip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { absolutePath, resolveFileRef, splitFileRefs } from "@/lib/fileRef";
import { requestOpenFile } from "@/lib/openFileRequest";
import { useProjectFiles } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** The project a transcript's file references are relative to. Context rather
 *  than a prop: the markdown renderer's component map is module-level, so
 *  there is nothing to thread a `cwd` through. */
const ProjectContext = createContext<string | null>(null);

export const FileRefProject = ProjectContext.Provider;

export const useProjectCwd = (): string | null => useContext(ProjectContext);

/**
 * A file named in the conversation: its filetype icon, its project path on
 * hover, and the editor on click.
 *
 * The project's file list is only fetched once a reference is actually
 * pointed at — messages name files constantly, and walking the tree to render
 * a transcript would be a walk nobody asked for. React Query dedupes it across
 * every chip on screen.
 */
export function FileRef(props: { path: string; label: string; className?: string }) {
  const cwd = useContext(ProjectContext);
  // Outside a project — a preview, a test harness — the chip is a label and
  // nothing more. Rendering the linked version instead would demand a query
  // client from every caller for a lookup that has nothing to look in.
  if (cwd === null) return <FileChip {...props} />;
  return <LinkedFileRef {...props} cwd={cwd} />;
}

function FileChip({
  path,
  label,
  className,
  interactive = false,
}: {
  path: string;
  label: string;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 rounded bg-muted px-1.5 py-0.5 align-baseline font-mono text-[0.9em]",
        // A clickable file ref reads as one before the cursor lands: a hairline
        // ring the plain inline code beside it doesn't have, and an accent
        // hover — link semantics, not a button treatment.
        interactive &&
          "cursor-pointer ring-1 ring-inset ring-foreground/10 transition-colors hover:bg-primary/10 hover:ring-primary/40",
        className
      )}
    >
      <FileTypeIcon path={path} className="translate-y-0.5 self-center" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function LinkedFileRef({
  path,
  label,
  className,
  cwd,
}: {
  path: string;
  label: string;
  className?: string;
  cwd: string;
}) {
  const [wanted, setWanted] = useState(false);
  const files = useProjectFiles(cwd, wanted);
  const relative = files.data ? resolveFileRef(path, files.data) : null;
  const open = () => {
    if (relative === null) return;
    requestOpenFile(absolutePath(relative, cwd));
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role={relative !== null ? "button" : undefined}
            tabIndex={relative !== null ? 0 : undefined}
            onPointerEnter={() => setWanted(true)}
            onFocus={() => setWanted(true)}
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }}
          >
            <FileChip
              path={path}
              label={label}
              className={className}
              interactive={relative !== null}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {/* Say what is known: the resolved project path, or that the lookup
              hasn't answered — never a path the project might not have. */}
          {relative ?? (files.isPending && wanted ? `${path}…` : path)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Plain (non-markdown) message text with its file references and web links
 * picked out. Used for the prose in a user's own message; fenced code is
 * split off and highlighted separately so a paste doesn't stay a wall of
 * backticks.
 */
export function TextWithFileRefs({ text }: { text: string }) {
  return (
    <>
      {splitFileRefs(text).map((segment, i) => {
        if (segment.kind === "file") {
          return (
            <FileRef
              key={`${i}:${segment.path}`}
              path={segment.path}
              label={segment.text}
            />
          );
        }
        if (segment.kind === "link") {
          return <LinkChip key={`${i}:${segment.href}`} href={segment.href} />;
        }
        return <span key={`${i}:text`}>{segment.text}</span>;
      })}
    </>
  );
}

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import {
  getThreadMeta,
  setThreadMeta,
  threadMetaKey,
} from "@/lib/threadMeta";
import { FORGE_NOUN, parsePrUrl, type LinkedPr } from "@/lib/forge";

export interface ThreadLink {
  projectPath: string;
  threadId: string;
}

const ThreadLinkContext = createContext<ThreadLink | null>(null);

export const ThreadLinkProvider = ThreadLinkContext.Provider;

/** A markdown link. Right-click a GitHub/GitLab PR URL to attach it to this
 *  thread so auto-settle follows that review, not just the worktree branch. */
export function PrLink({
  href,
  children,
  ...rest
}: ComponentProps<"a">) {
  const thread = useContext(ThreadLinkContext);
  const parsed = href ? parsePrUrl(href) : null;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const linked =
    thread && parsed
      ? getThreadMeta(threadMetaKey(thread.projectPath, thread.threadId)).linkedPr
      : undefined;
  const isLinked =
    !!linked &&
    !!parsed &&
    linked.host === parsed.host &&
    linked.iid === parsed.iid;

  const apply = (next: LinkedPr | undefined) => {
    if (!thread) return;
    setThreadMeta(threadMetaKey(thread.projectPath, thread.threadId), {
      linkedPr: next,
    });
    setMenu(null);
  };

  return (
    <>
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
        onContextMenu={(e) => {
          if (!thread || !parsed) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </a>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            style={{ left: menu.x, top: menu.y }}
            className="fixed z-50 min-w-44 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
          >
            {isLinked ? (
              <button
                type="button"
                className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => apply(undefined)}
              >
                Unlink from thread
              </button>
            ) : (
              <button
                type="button"
                className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                onClick={() => parsed && apply(parsed)}
              >
                Link {FORGE_NOUN[parsed?.host ?? "github"].one} to thread
              </button>
            )}
          </div>,
          document.body
        )}
    </>
  );
}

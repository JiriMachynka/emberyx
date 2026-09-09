import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
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

interface ThreadLinkState {
  thread: ThreadLink | null;
  /** The PR/MR attached to this thread. Held here rather than read per link:
   *  `getThreadMeta` parses the whole store — every thread of every project —
   *  and `PrLink` is the renderer for every link in every message. */
  linkedPr: LinkedPr | undefined;
}

const ThreadLinkContext = createContext<ThreadLinkState>({
  thread: null,
  linkedPr: undefined,
});

/** Value equality: the store is re-parsed on every write, anywhere, so the same
 *  link would arrive as a new object and re-render every rendered link. */
const samePr = (a: LinkedPr | undefined, b: LinkedPr | undefined): boolean =>
  a === b ||
  (a != null && b != null && a.host === b.host && a.iid === b.iid && a.url === b.url);

/** Is `parsed` the request this thread is following? Compared by host and
 *  number, not URL — the same MR is linkable from several spellings of its
 *  address. */
export const isLinkedPr = (
  linked: LinkedPr | undefined,
  parsed: LinkedPr | null
): boolean => linked != null && parsed != null && linked.host === parsed.host && linked.iid === parsed.iid;

export function ThreadLinkProvider({
  value,
  children,
}: {
  value: ThreadLink | null;
  children: ReactNode;
}) {
  const key = value ? threadMetaKey(value.projectPath, value.threadId) : null;
  const [linkedPr, setLinkedPr] = useState<LinkedPr | undefined>(() =>
    key ? getThreadMeta(key).linkedPr : undefined
  );

  useEffect(() => {
    const read = () => {
      const next = key ? getThreadMeta(key).linkedPr : undefined;
      setLinkedPr((prev) => (samePr(prev, next) ? prev : next));
    };
    read();
    window.addEventListener("emberyx-thread-meta", read);
    return () => window.removeEventListener("emberyx-thread-meta", read);
  }, [key]);

  const state = useMemo(
    () => ({ thread: value, linkedPr }),
    [value, linkedPr]
  );
  return (
    <ThreadLinkContext.Provider value={state}>{children}</ThreadLinkContext.Provider>
  );
}

/** A markdown link. Right-click a GitHub/GitLab PR URL to attach it to this
 *  thread so auto-settle follows that review, not just the worktree branch. */
export function PrLink({
  href,
  children,
  ...rest
}: ComponentProps<"a">) {
  const { thread, linkedPr } = useContext(ThreadLinkContext);
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

  const isLinked = thread != null && isLinkedPr(linkedPr, parsed);

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

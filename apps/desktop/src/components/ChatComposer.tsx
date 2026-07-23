import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Coins, Sparkles, Square, X } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { MentionMenu } from "@/components/MentionMenu";
import { SlashMenu } from "@/components/SlashMenu";
import { fuzzyFilter } from "@/lib/fuzzy";
import { applyMention, mentionAt, type Mention } from "@/lib/mentions";
import { applySlash, filterCommands, slashAt, type SlashToken } from "@/lib/slash";
import { useProjectFiles, useSlashCommands } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { ChatImage, ChatUsage } from "@/hooks/useAgentChat";

/** Suggestions shown for an `@` file reference. */
const MENTION_LIMIT = 8;

/** Rows shown in the `/` command menu. */
const COMMAND_LIMIT = 12;

/** Reconstruct a data: URL for rendering from a stored ChatImage. */
const imageSrc = (img: ChatImage) => `data:${img.mediaType};base64,${img.data}`;

/** Anthropic downsizes vision inputs past this; do it client-side to keep the
 *  base64 (which lives in the in-memory message history) small. */
const MAX_EDGE = 1568;

const processImage = (file: File): Promise<ChatImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const strip = (url: string, mediaType: string): ChatImage => ({
        id: crypto.randomUUID(),
        mediaType,
        data: url.slice(url.indexOf(",") + 1),
      });
      const img = new Image();
      img.onerror = () => resolve(strip(dataUrl, file.type));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        if (scale === 1) {
          resolve(strip(dataUrl, file.type));
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(strip(dataUrl, file.type));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const type = file.type === "image/png" ? "image/png" : "image/jpeg";
        resolve(strip(canvas.toDataURL(type, 0.9), type));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });

/** "claude-opus-4-8" → "Opus 4.8"; strips date/bracket suffixes. */
const prettyModel = (id: string): string => {
  const family = ["opus", "sonnet", "haiku", "fable"].find((f) => id.includes(f));
  if (!family) return id;
  const nums = id.replace(/\[.*?\]/g, "").replace(/\d{8}/g, "").match(/\d+/g);
  const version = (nums ?? []).slice(0, 2).join(".");
  const name = family[0].toUpperCase() + family.slice(1);
  return version ? `${name} ${version}` : name;
};

interface ChatComposerProps {
  /** Project root — the corpus for `@` file references. */
  cwd: string;
  /** Focus the textarea when this pane becomes the visible tab. */
  active: boolean;
  ready: boolean;
  busy: boolean;
  exited: boolean;
  /** True while a permission prompt owns the keyboard. */
  blocked: boolean;
  usage: ChatUsage;
  onSend: (text: string, images: ChatImage[]) => void;
  onStop: () => void;
  onPreview: (dataUrl: string) => void;
}

/**
 * The message box: text, pasted images, `@` file references, and the usage
 * footer. It owns the draft so typing never re-renders the transcript above it
 * — with a long thread, re-rendering every markdown block per keystroke is what
 * makes the composer feel laggy.
 */
export function ChatComposer({
  cwd,
  active,
  ready,
  busy,
  exited,
  blocked,
  usage,
  onSend,
  onStop,
  onPreview,
}: ChatComposerProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [dragging, setDragging] = useState(false);
  // Only one menu can be open: `/` lives at the very start, `@` never does.
  const [mention, setMention] = useState<Mention | null>(null);
  const [slash, setSlash] = useState<SlashToken | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The file list is walked once per project and cached; only fetch it after an
  // `@` is actually typed.
  const filesQuery = useProjectFiles(cwd, mention !== null);
  const mentionHits = useMemo(
    () =>
      mention ? fuzzyFilter(filesQuery.data ?? [], mention.query, MENTION_LIMIT) : [],
    [filesQuery.data, mention]
  );

  const commandsQuery = useSlashCommands(cwd, slash !== null);
  const commandHits = useMemo(
    () =>
      slash
        ? filterCommands(commandsQuery.data ?? [], slash.query, COMMAND_LIMIT)
        : [],
    [commandsQuery.data, slash]
  );

  const menuLength = mention ? mentionHits.length : slash ? commandHits.length : 0;
  const menuActive = Math.min(menuIndex, Math.max(0, menuLength - 1));

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  // Grow the composer with its content, capped by max-h-40 (then it scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const closeMenus = () => {
    setMention(null);
    setSlash(null);
  };

  const submit = () => {
    if ((!input.trim() && images.length === 0) || !ready) return;
    onSend(input, images);
    setInput("");
    setImages([]);
    closeMenus();
  };

  /** Track the caret after every edit / move so a menu opens and closes with the
   *  token the caret is actually in. */
  const syncMenus = (el: HTMLTextAreaElement) => {
    setMention(mentionAt(el.value, el.selectionStart));
    setSlash(slashAt(el.value, el.selectionStart));
    setMenuIndex(0);
  };

  /** Swap the typed token for a completion and put the caret after it. */
  const complete = (next: { text: string; caret: number }) => {
    const el = inputRef.current;
    if (!el) return;
    setInput(next.text);
    closeMenus();
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const pickMention = (relPath: string) => {
    const el = inputRef.current;
    if (!el || !mention) return;
    complete(applyMention(input, mention, relPath, el.selectionStart));
  };

  const pickCommand = (name: string) => {
    const el = inputRef.current;
    if (!el) return;
    complete(applySlash(input, name, el.selectionStart));
  };

  const pickActive = () => {
    if (mention && mentionHits[menuActive]) {
      pickMention(mentionHits[menuActive].value);
      return true;
    }
    if (slash && commandHits[menuActive]) {
      pickCommand(commandHits[menuActive].name);
      return true;
    }
    return false;
  };

  const appendImages = (files: File[]) => {
    if (files.length === 0) return;
    void Promise.all(files.map(processImage)).then((imgs) => {
      setImages((prev) => [...prev, ...imgs]);
    });
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    appendImages(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    appendImages(
      Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"))
    );
  };

  return (
    <>
      {mention && (
        <MentionMenu
          hits={mentionHits}
          indexing={filesQuery.isPending}
          query={mention.query}
          active={menuActive}
          onHover={setMenuIndex}
          onPick={pickMention}
        />
      )}
      {slash && (
        <SlashMenu
          commands={commandHits}
          loading={commandsQuery.isPending}
          query={slash.query}
          active={menuActive}
          onHover={setMenuIndex}
          onPick={pickCommand}
        />
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          "overflow-hidden rounded-xl border border-input bg-card shadow-sm transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40",
          dragging && "border-ring ring-1 ring-ring/50"
        )}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3.5 pt-3">
            {images.map((img) => (
              <div
                key={img.id}
                className="group relative size-14 overflow-hidden rounded-lg border border-border"
              >
                <button
                  type="button"
                  onClick={() => onPreview(imageSrc(img))}
                  className="block size-full"
                >
                  <img src={imageSrc(img)} alt="" className="size-full object-cover" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setImages((prev) => prev.filter((i) => i.id !== img.id))
                  }
                  className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-foreground opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            syncMenus(e.currentTarget);
          }}
          onClick={(e) => syncMenus(e.currentTarget)}
          onKeyUp={(e) => {
            // Caret moves can leave (or enter) a token, but Up/Down drive the
            // menu highlight — resyncing on those would reset it to row 0.
            const menuOpen = mention != null || slash != null;
            if (menuOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
            if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") {
              syncMenus(e.currentTarget);
            }
          }}
          onBlur={closeMenus}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // An open menu owns Enter, Tab, arrows and Esc.
            if (menuLength > 0 || slash) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMenuIndex((i) => Math.min(i + 1, menuLength - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                // Enter still sends when the typed command is already complete.
                if (pickActive()) {
                  e.preventDefault();
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeMenus();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            exited ? "Session ended" : ready ? "Message Claude…" : "Starting agent…"
          }
          disabled={!ready || busy || exited || blocked}
          rows={1}
          className="max-h-40 min-h-16 resize-none overflow-y-auto border-0 bg-transparent px-3.5 pb-1 pt-3 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
          <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
            {usage.model && (
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                <span className="truncate">{prettyModel(usage.model)}</span>
              </span>
            )}
            {(usage.inputTokens != null ||
              usage.outputTokens != null ||
              usage.costUsd != null) && (
              <span className="flex items-center gap-2 font-mono tabular-nums">
                {usage.inputTokens != null && (
                  <span className="flex items-center gap-0.5">
                    <ArrowDown className="size-3 opacity-60" />
                    {usage.inputTokens.toLocaleString("en-US")}
                  </span>
                )}
                {usage.outputTokens != null && (
                  <span className="flex items-center gap-0.5">
                    <ArrowUp className="size-3 opacity-60" />
                    {usage.outputTokens.toLocaleString("en-US")}
                  </span>
                )}
                {usage.costUsd != null && (
                  <span className="flex items-center gap-0.5 text-primary">
                    <Coins className="size-3 opacity-70" />${usage.costUsd.toFixed(4)}
                  </span>
                )}
              </span>
            )}
          </div>
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop"
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-card text-foreground transition-colors hover:bg-muted"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={(!input.trim() && images.length === 0) || !ready || exited}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}

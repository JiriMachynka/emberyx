import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsUpDown,
  ClipboardList,
  Clock,
  Coins,
  Hammer,
  Lock,
  Sparkles,
  Square,
  Unlock,
  X,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

/** Model families, each expanding to a "Latest" alias plus pinned versions.
 *  Values are passed straight to `claude --model` (aliases or full ids);
 *  "" (Default) lets the CLI resolve the model. */
const MODEL_GROUPS: { label: string; options: { value: string; label: string }[] }[] = [
  {
    label: "Opus",
    options: [
      { value: "opus", label: "Latest" },
      { value: "claude-opus-5", label: "Opus 5" },
      { value: "claude-opus-4-8", label: "Opus 4.8" },
      { value: "claude-opus-4-7", label: "Opus 4.7" },
      { value: "claude-opus-4-6", label: "Opus 4.6" },
    ],
  },
  {
    label: "Sonnet",
    options: [
      { value: "sonnet", label: "Latest" },
      { value: "claude-sonnet-5", label: "Sonnet 5" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { value: "sonnet[1m]", label: "Sonnet (1M)" },
    ],
  },
  {
    label: "Haiku",
    options: [
      { value: "haiku", label: "Latest" },
      { value: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
  },
];

/** Human label for a stored value: the pinned name, or the family name for a
 *  bare "Latest" alias. Falls back to prettyModel for anything unknown. */
const modelLabel = (value: string): string => {
  for (const g of MODEL_GROUPS) {
    const o = g.options.find((x) => x.value === value);
    if (o) return o.label === "Latest" ? g.label : o.label;
  }
  return prettyModel(value);
};

interface ModelPickerProps {
  /** Selected `--model` value for this session; "" = default. */
  model: string;
  usage: ChatUsage;
  onModelChange: (model: string) => void;
}

/** Dropdown that swaps the running model. "Default" shows the model the CLI
 *  actually resolved (from usage) so the footer still reads e.g. "Opus 5".
 *  Families open a submenu of pinned versions. */
const ModelPicker = memo(function ModelPicker({
  model,
  usage,
  onModelChange,
}: ModelPickerProps) {
  const label =
    model === ""
      ? usage.model
        ? prettyModel(usage.model)
        : "Default"
      : modelLabel(model);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded font-medium text-foreground outline-none transition-colors hover:text-primary">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">{label}</span>
        <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36">
        <DropdownMenuItem
          onSelect={() => onModelChange("")}
          className="justify-between gap-4"
        >
          {usage.model ? `Default (${prettyModel(usage.model)})` : "Default"}
          {model === "" && <Check className="size-3.5" />}
        </DropdownMenuItem>
        {MODEL_GROUPS.map((g) => {
          const active = g.options.some((o) => o.value === model);
          return (
            <DropdownMenuSub key={g.label}>
              <DropdownMenuSubTrigger className={active ? "text-primary" : undefined}>
                {g.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {g.options.map((o) => (
                  <DropdownMenuItem
                    key={o.value}
                    onSelect={() => onModelChange(o.value)}
                    className="justify-between gap-4"
                  >
                    {o.label}
                    {o.value === model && <Check className="size-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Thin vertical rule between composer control chips. */
const ChipDivider = () => <span className="h-3.5 w-px shrink-0 bg-border" />;

/** Trigger styling shared by the access/mode chips — matches ModelPicker. */
const chipTrigger =
  "flex items-center gap-1.5 rounded font-medium text-foreground outline-none transition-colors hover:text-primary";

/** Approval posture: Full access (`--dangerously-skip-permissions`) vs
 *  Supervised (edits/commands raise a permission prompt). */
const AccessChip = memo(function AccessChip({
  fullAccess,
  onChange,
}: {
  fullAccess: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        {fullAccess ? (
          <Unlock className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Lock className="size-3.5 shrink-0 opacity-70" />
        )}
        <span>{fullAccess ? "Full access" : "Supervised"}</span>
        <ChevronDown className="size-3 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem onSelect={() => onChange(false)} className="justify-between gap-4">
          Supervised
          {!fullAccess && <Check className="size-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange(true)} className="justify-between gap-4">
          Full access
          {fullAccess && <Check className="size-3.5" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Interaction mode: Build (agent edits) vs Plan (`--permission-mode plan`,
 *  read-only until you approve the plan). */
const ModeChip = memo(function ModeChip({
  planMode,
  onChange,
}: {
  planMode: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        {planMode ? (
          <ClipboardList className="size-3.5 shrink-0 text-primary" />
        ) : (
          <Hammer className="size-3.5 shrink-0 opacity-70" />
        )}
        <span>{planMode ? "Plan" : "Build"}</span>
        <ChevronDown className="size-3 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36">
        <DropdownMenuItem onSelect={() => onChange(false)} className="justify-between gap-4">
          Build
          {!planMode && <Check className="size-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange(true)} className="justify-between gap-4">
          Plan
          {planMode && <Check className="size-3.5" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Context-window size by model alias — everything is 200k except the 1M
 *  Sonnet variant. */
const contextWindowFor = (model: string): number =>
  model.includes("[1m]") ? 1_000_000 : 200_000;

/** Compact token count: 135k, 1m. */
const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`
    : `${Math.round(n / 1000)}k`;

const RING = 2 * Math.PI * 8; // r=8 circumference

/** Ring gauge beside the send button; its popover shows how full the context
 *  window is. Kept its own memo so typing never re-renders the SVG. */
const ContextMeter = memo(function ContextMeter({
  contextTokens,
  model,
}: {
  contextTokens?: number;
  model: string;
}) {
  const max = contextWindowFor(model);
  const used = contextTokens ?? 0;
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Context window"
        className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground"
      >
        <svg viewBox="0 0 20 20" className="size-5 -rotate-90">
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            strokeWidth="2"
            className="stroke-muted-foreground/25"
          />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - pct / 100)}
            className="stroke-primary transition-[stroke-dashoffset]"
          />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Context Window</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {pct}% · {fmtTokens(used)}/{fmtTokens(max)}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Claude automatically compacts its context when needed.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

interface UsageFooterProps {
  /** Turns typed while busy and not yet sent. */
  queued: number;
  usage: ChatUsage;
  /** Selected `--model` alias; "" = default. */
  model: string;
  onModelChange: (model: string) => void;
  fullAccess: boolean;
  onFullAccessChange: (v: boolean) => void;
  planMode: boolean;
  onPlanModeChange: (v: boolean) => void;
}

/** Token/cost telemetry restated on every message_delta. Split out so that
 *  churn re-renders this row alone, and so typing (which changes the composer's
 *  draft state, not the usage) skips it. */
const UsageFooter = memo(function UsageFooter({
  queued,
  usage,
  model,
  onModelChange,
  fullAccess,
  onFullAccessChange,
  planMode,
  onPlanModeChange,
}: UsageFooterProps) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
      {queued > 0 && (
        <span className="flex shrink-0 items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[0.7rem]">
          <Clock className="size-3" />
          {queued} queued
        </span>
      )}
      <ModelPicker model={model} usage={usage} onModelChange={onModelChange} />
      <ChipDivider />
      <AccessChip fullAccess={fullAccess} onChange={onFullAccessChange} />
      <ChipDivider />
      <ModeChip planMode={planMode} onChange={onPlanModeChange} />
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
  );
});

interface ChatComposerProps {
  /** Project root — the corpus for `@` file references. */
  cwd: string;
  /** Focus the textarea when this pane becomes the visible tab. */
  active: boolean;
  ready: boolean;
  busy: boolean;
  /** Turns typed while busy and not yet sent. */
  queued: number;
  exited: boolean;
  /** True while a permission prompt owns the keyboard. */
  usage: ChatUsage;
  /** Selected `--model` alias for this session; "" = default. */
  model: string;
  onModelChange: (model: string) => void;
  /** Full access = `--dangerously-skip-permissions`; off = Supervised. */
  fullAccess: boolean;
  onFullAccessChange: (v: boolean) => void;
  /** Plan mode = `--permission-mode plan`; off = Build. */
  planMode: boolean;
  onPlanModeChange: (v: boolean) => void;
  onSend: (text: string, images: ChatImage[]) => void;
  onStop: () => void;
  /** Un-send the newest in-flight turn; returns its text/images to restore. */
  onRewind: () => { text: string; images?: ChatImage[] } | null;
  onPreview: (dataUrl: string) => void;
}

/**
 * The message box: text, pasted images, `@` file references, and the usage
 * footer. It owns the draft so typing never re-renders the transcript above it
 * — with a long thread, re-rendering every markdown block per keystroke is what
 * makes the composer feel laggy.
 */
export const ChatComposer = memo(function ChatComposer({
  cwd,
  active,
  ready,
  busy,
  queued,
  exited,
  usage,
  model,
  onModelChange,
  fullAccess,
  onFullAccessChange,
  planMode,
  onPlanModeChange,
  onSend,
  onStop,
  onRewind,
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
  const heightRef = useRef("");
  const lengthRef = useRef(0);
  const frameRef = useRef(0);

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
  // Measuring forces a reflow, so coalesce a burst of keystrokes into one frame,
  // skip the write when the height is unchanged, and only reset to `auto` when
  // the text got shorter — growing text can be measured in place.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      if (input.length <= lengthRef.current) el.style.height = "auto";
      lengthRef.current = input.length;
      const next = `${Math.min(el.scrollHeight, 160)}px`;
      if (next !== heightRef.current || el.style.height === "auto") {
        heightRef.current = next;
        el.style.height = next;
      }
    });
    return () => cancelAnimationFrame(frameRef.current);
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

  /** Escape while a turn is in flight: pull the just-sent message back into the
   *  box to edit. A draft already typed is kept, below the restored text. */
  const rewindToDraft = (): boolean => {
    const r = onRewind();
    if (!r) return false;
    setInput((prev) => (prev.trim() ? `${r.text}\n${prev}` : r.text));
    const imgs = r.images;
    if (imgs && imgs.length > 0) setImages((prev) => [...imgs, ...prev]);
    closeMenus();
    requestAnimationFrame(() => inputRef.current?.focus());
    return true;
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
          "glass-composer overflow-hidden rounded-xl border border-input transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40",
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
            if (e.key === "Escape" && (busy || queued > 0)) {
              if (rewindToDraft()) {
                e.preventDefault();
                return;
              }
            }
            // Swallow any otherwise-unhandled Esc so it can't reach the OS and
            // exit fullscreen / unmaximize the window.
            if (e.key === "Escape") {
              e.preventDefault();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            exited
              ? "Session ended"
              : !ready
                ? "Starting agent…"
                : busy
                  ? "Queue a message…"
                  : "Message Claude…"
          }
          disabled={!ready || exited}
          rows={1}
          className="max-h-40 min-h-16 resize-none overflow-y-auto border-0 bg-transparent px-3.5 pb-1 pt-3 shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
          <UsageFooter
            queued={queued}
            usage={usage}
            model={model}
            onModelChange={onModelChange}
            fullAccess={fullAccess}
            onFullAccessChange={onFullAccessChange}
            planMode={planMode}
            onPlanModeChange={onPlanModeChange}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <ContextMeter contextTokens={usage.contextTokens} model={model} />
            {busy && (
              <button
                type="button"
                onClick={onStop}
                title="Stop"
                className="grid size-8 place-items-center rounded-full bg-card text-foreground transition-colors hover:bg-muted"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            )}
            <button
              type="button"
              onClick={submit}
              title={busy ? "Queue message" : "Send"}
              disabled={(!input.trim() && images.length === 0) || !ready || exited}
              className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </>
  );
});

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  ImagePlus,
  ScanText,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MentionMenu } from "@/components/MentionMenu";
import { SlashMenu } from "@/components/SlashMenu";
import { fuzzyFilter } from "@/lib/fuzzy";
import {
  COMMAND_SIGIL,
  capabilitiesOf,
  type AgentBackend,
} from "@/lib/agentBackend";
import type { AccessLevel, ClaudeProfile } from "@/lib/settings";
import type { KeepGoing } from "@/lib/keepGoing";
import { applyMention, mentionAt, type Mention } from "@/lib/mentions";
import {
  compactDisabledReason,
  formatResumeCompactionQuestion,
  shouldOfferResumeCompaction,
} from "@/lib/compact";
import { pasteInsertion } from "@/lib/fileRef";
import { mimeForImageFile } from "@/lib/chatImage";
import { applySlash, filterCommands, slashAt, type SlashToken } from "@/lib/slash";
import {
  useGitBranch,
  useProjectFiles,
  useSlashCommands,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { PromptQueue } from "@/lib/promptQueue";
import { useAgentStore } from "@/lib/agentStore";
import type { ChatImage, ChatUsage } from "@/hooks/useAgentChat";
import { imageSrc } from "@/components/chat/imageSrc";
import { processImage } from "@/components/composer/processImage";
import { BranchChip } from "@/components/composer/BranchChip";
import { ContextMeter } from "@/components/composer/ContextMeter";
import { QuotaChip } from "@/components/composer/QuotaChip";
import { UsageFooter } from "@/components/composer/UsageFooter";

/** Suggestions shown for an `@` file reference. */
const MENTION_LIMIT = 8;

/** Rows shown in the `/` command menu. */
const COMMAND_LIMIT = 12;

interface ChatComposerProps {
  /** Project root — the corpus for `@` file references. */
  cwd: string;
  /** Agent CLI this chat drives; gates the Claude-only chips and menus. */
  backend: AgentBackend;
  /** Focus the textarea when this pane becomes the visible tab. */
  active: boolean;
  /** Same stack the transcript above uses. */
  fontFamily: string;
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
  /** Selected reasoning effort for this session; "" = let the CLI decide. */
  effort: string;
  onEffortChange: (effort: string) => void;
  /** Full access = `--dangerously-skip-permissions`; off = Supervised. */
  access: AccessLevel;
  onAccessChange: (v: AccessLevel) => void;
  /** Move the thread to another provider in place. */
  onSwitchBackend: (backend: AgentBackend) => void;
  /** Extra named Claude setups. Empty = the default Claude only. */
  claudeProfiles?: ClaudeProfile[];
  claudeProfileId?: string | null;
  onClaudeProfileChange?: (id: string | null) => void;
  /** Runtime-owned prompt queue for reorder/edit/delete/pause/run-next. */
  queue?: PromptQueue | null;
  keepGoing?: KeepGoing;
  onKeepGoingChange?: (next: KeepGoing | undefined) => void;
  onKeepGoingStop?: () => void;
  onOpenWorktree?: (path: string, repoRoot: string, branch: string) => void;
  /** Text handed to this chat from elsewhere, to drop into the box unsent. */
  draft?: string;
  onDraftConsumed: () => void;
  /** First sign the user means to talk to this thread. A resumed pane has no
   *  process until then, so this is what starts it — by the time the message is
   *  sent the agent is usually already up. */
  onTyping?: () => void;
  onSend: (text: string, images: ChatImage[]) => void;
  /** Compact the live context window. Absent when this backend cannot. */
  onCompact?: () => void;
  /** Wall-clock of the newest turn, for the idle-session compact ask. */
  lastActivityAt?: number;
  onStop: () => void;
  /** Un-send the newest in-flight turn; returns its text/images to restore. */
  onRewind: () => { text: string; images?: ChatImage[] } | null;
  /** Open the lightbox. The second argument carries a snapshot's
   *  accessibility tree, which renders under the image. */
  onPreview: (dataUrl: string, a11y?: string) => void;
}

/**
 * The message box: text, pasted images, `@` file references, and the usage
 * footer. It owns the draft so typing never re-renders the transcript above it
 * — with a long thread, re-rendering every markdown block per keystroke is what
 * makes the composer feel laggy.
 */
export const ChatComposer = memo(function ChatComposer({
  cwd,
  backend,
  active,
  fontFamily,
  ready,
  busy,
  queued,
  exited,
  usage,
  model,
  onModelChange,
  effort,
  onEffortChange,
  access,
  onAccessChange,
  onSwitchBackend,
  claudeProfiles = [],
  claudeProfileId = null,
  onClaudeProfileChange,
  queue,
  keepGoing,
  onKeepGoingChange,
  onKeepGoingStop,
  onOpenWorktree,
  draft,
  onDraftConsumed,
  onTyping,
  onSend,
  onCompact,
  lastActivityAt,
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
  const [resumeOffer, setResumeOffer] = useState<{
    ageMinutes: number;
    usedTokens: number;
  } | null>(null);
  const neverResumeAsk = useRef(false);
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

  const slashCommands = capabilitiesOf(backend).slashCommands;
  const sigil = COMMAND_SIGIL[backend];
  const commandsQuery = useSlashCommands(cwd, slashCommands && slash !== null, backend);
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

  // SnapShots: the store's one-slot inbox lands on the focused composer.
  // `consumePendingSnapshot` check-and-clears atomically, so a second mounted
  // composer can't take the same capture, and a capture made while this pane
  // was backgrounded is here when it becomes active again.
  const pendingSnapshot = useAgentStore((s) => s.pendingSnapshot);
  const consumePendingSnapshot = useAgentStore((s) => s.consumePendingSnapshot);
  useEffect(() => {
    if (!active || exited) return;
    const snap = consumePendingSnapshot();
    if (snap) setImages((prev) => [...prev, snap]);
  }, [active, exited, pendingSnapshot, consumePendingSnapshot]);

  // A handed-off message lands here rather than being sent, so the user reads
  // it before committing. Anything already typed is kept above it.
  useEffect(() => {
    if (draft === undefined) return;
    setInput((prev) => (prev.trim() ? `${prev}\n\n${draft}` : draft));
    onDraftConsumed();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [draft, onDraftConsumed]);

  // Grow the composer with its content, capped by max-h-40 (then it scrolls).
  // Measuring forces a reflow, so coalesce a burst of keystrokes into one frame,
  // skip the write when the height is unchanged, and only reset to `auto` when
  // the text got shorter — growing text can be measured in place.
  // Layout effect, not effect: the height is measured and written before the
  // browser paints, so the composer never shows a frame at its unmeasured
  // height on mount.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // First pass runs inline; only a burst of keystrokes needs coalescing.
    const size = () => {
      if (input.length <= lengthRef.current) {
        // Measuring needs the height released, but `auto` is a jump the
        // transition would then animate *from* — so the reset happens with
        // transitions off and is flushed before they come back.
        el.style.transition = "none";
        el.style.height = "auto";
        void el.offsetHeight;
        el.style.transition = "";
      }
      lengthRef.current = input.length;
      const next = `${Math.min(el.scrollHeight, 160)}px`;
      if (next !== heightRef.current || el.style.height === "auto") {
        heightRef.current = next;
        el.style.height = next;
      }
    };
    if (heightRef.current === "") {
      size();
      return;
    }
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(size);
    return () => cancelAnimationFrame(frameRef.current);
  }, [input]);

  const closeMenus = () => {
    setMention(null);
    setSlash(null);
  };

  const submit = () => {
    if ((!input.trim() && images.length === 0) || exited) return;
    if (
      onCompact &&
      !neverResumeAsk.current &&
      !resumeOffer &&
      shouldOfferResumeCompaction({
        backend,
        usedTokens: usage.contextTokens ?? 0,
        lastActivityAt,
        now: Date.now(),
      })
    ) {
      const ageMinutes = Math.max(
        0,
        Math.round((Date.now() - (lastActivityAt ?? Date.now())) / 60_000)
      );
      setResumeOffer({ ageMinutes, usedTokens: usage.contextTokens ?? 0 });
      return;
    }
    onSend(input, images);
    setInput("");
    setImages([]);
    setResumeOffer(null);
    closeMenus();
  };

  const canCompact = capabilitiesOf(backend).compact && onCompact;
  // Read here too, so the strip under the input can stay out of the DOM
  // entirely for a project that is not a git repo. Same query key as the
  // chip's, so it costs a cache read rather than a second `git branch`.
  const branch = useGitBranch(cwd).data?.branch;
  const hasStrip = !!branch || capabilitiesOf(backend).usage;
  const compactBlocked = compactDisabledReason({
    busy,
    ready: ready && !exited,
    usedTokens: usage.contextTokens ?? 0,
  });

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
    setSlash(slashCommands ? slashAt(el.value, el.selectionStart, sigil) : null);
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
      // The auto-resize effect writes the height a frame later, which undoes
      // the scroll-to-caret this just did — re-assert it afterwards, or a
      // completion that lands past the max-height sits out of view.
      requestAnimationFrame(() => el.setSelectionRange(next.caret, next.caret));
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
    complete(applySlash(input, name, el.selectionStart, sigil));
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

  const fileRef = useRef<HTMLInputElement>(null);

  const appendImages = (files: File[]) => {
    const jobs = files.flatMap((file) => {
      const mime = mimeForImageFile(file);
      return mime ? [processImage(file, mime)] : [];
    });
    if (jobs.length === 0) return;
    void Promise.all(jobs)
      .then((imgs) => setImages((prev) => [...prev, ...imgs]))
      .catch((e) => console.error("[emberyx] image attach failed", e));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fromItems = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null && mimeForImageFile(f) !== null);
    const files =
      fromItems.length > 0
        ? fromItems
        : Array.from(e.clipboardData?.files ?? []).filter(
            (f) => mimeForImageFile(f) !== null
          );
    if (files.length > 0) {
      e.preventDefault();
      appendImages(files);
      return;
    }

    // A pasted path becomes the mention it means, a pasted snippet gets its
    // language. Anything else falls through to the browser's own paste.
    const el = e.currentTarget;
    const next = pasteInsertion({
      value: input,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
      pasted: e.clipboardData?.getData("text/plain") ?? "",
      cwd,
    });
    if (!next) return;
    e.preventDefault();
    complete(next);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    appendImages(
      Array.from(e.dataTransfer.files).filter((f) => mimeForImageFile(f) !== null)
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
          sigil={sigil}
          onHover={setMenuIndex}
          onPick={pickCommand}
        />
      )}
      <div
        style={{ fontFamily }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          // rounded-xl, not 3xl: every card in the app is on the --radius
          // scale, and a 24px pill next to 10px tool cards reads as a
          // different design system.
          // Rounded all the way round: the session strip tucks *under* this
          // surface rather than squaring its bottom corners, the same trick
          // TasksCard uses above the composer.
          "chat-composer-surface relative z-10 overflow-hidden rounded-xl border transition-colors",
          "focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50",
          // A drop target, but never louder than focus — dragging used to draw
          // the stronger ring of the two.
          dragging && "border-primary/50 bg-primary/5 ring-1 ring-primary/25"
        )}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-5 pt-4">
            {images.map((img) => (
              <div
                key={img.id}
                className="relative size-16 overflow-hidden rounded-lg border border-border"
              >
                <button
                  type="button"
                  onClick={() => onPreview(imageSrc(img), img.snapshot?.a11y)}
                  className="block size-full"
                  title={
                    img.snapshot
                      ? `${img.snapshot.app}${img.snapshot.title ? ` — ${img.snapshot.title}` : ""}`
                      : undefined
                  }
                >
                  <img src={imageSrc(img)} alt="" className="size-full object-cover" />
                </button>
                {/* A snapshot names what was captured; the badge marks a tree
                    waiting under the image in the lightbox. */}
                {img.snapshot && (
                  <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 text-xs leading-4 text-foreground">
                    {img.snapshot.app}
                  </span>
                )}
                {img.snapshot?.a11y && (
                  <span
                    title="Includes accessibility tree"
                    className="absolute left-1 top-1 rounded bg-background/80 p-0.5 text-foreground"
                  >
                    <ScanText className="size-3" />
                  </span>
                )}
                {/* Always visible: a remove affordance that only appears on
                    hover is one a trackpad user has to go hunting for. */}
                <button
                  type="button"
                  title="Remove"
                  onClick={() =>
                    setImages((prev) => prev.filter((i) => i.id !== img.id))
                  }
                  className="absolute right-1 top-1 rounded-full bg-background/70 p-0.5 text-foreground transition-colors hover:bg-background"
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
            onTyping?.();
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
              : busy
                ? "Queue a message…"
                : "Ask for changes, send follow-ups, or attach images"
          }
          disabled={exited}
          rows={1}
          // `block` overrides the shadcn base's `flex`: as a flex container the
          // textarea's inner editor gets a min-content floor, so one long
          // unbreakable token (an @path mention) pushes the line wider than the
          // box instead of wrapping. `break-words` wraps the token itself.
          // `min-h-0`, not a one-line floor: the measured height is the only
          // thing that governs, so an empty composer is exactly one line of
          // padding + text with no slack under the placeholder. The shadcn
          // base ships `min-h-16`, which is where the old blank strip came
          // from. It still grows to max-h-40 and then scrolls.
          className="block max-h-40 min-h-0 resize-none overscroll-contain overflow-x-hidden overflow-y-auto break-words border-0 bg-transparent px-5 pb-2 pt-3 text-base leading-6 shadow-none transition-[height] duration-150 ease-out placeholder:text-muted-foreground/80 focus-visible:ring-0 motion-reduce:transition-none"
        />
          {resumeOffer && (
            <div className="flex flex-col gap-2 border-t border-border px-4 py-2">
              <p className="text-sm">{formatResumeCompactionQuestion(resumeOffer)}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!!compactBlocked}
                  onClick={() => {
                    onCompact?.();
                    setResumeOffer(null);
                  }}
                >
                  Compact
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={submit}>
                  Send anyway
                </Button>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    neverResumeAsk.current = true;
                    submit();
                  }}
                >
                  Don't ask again
                </button>
              </div>
            </div>
          )}
          {/* pl-2.5 rather than the textarea's px-5: each chip carries its own
              px-2.5, so this is what puts the first chip's glyph on the same
              left edge as the prompt text above it. */}
          {/* Wraps rather than scrolling sideways: chips that slid out of view
              inside the input were discoverable only by scrolling a toolbar
              nobody knows scrolls. */}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-2 pb-4 pl-2.5 pr-5 pt-2">
          <UsageFooter
            queued={queued}
            backend={backend}
            cwd={cwd}
            usage={usage}
            model={model}
            onModelChange={onModelChange}
            effort={effort}
            onEffortChange={onEffortChange}
            access={access}
            onAccessChange={onAccessChange}
            onSwitchBackend={onSwitchBackend}
            claudeProfiles={claudeProfiles}
            claudeProfileId={claudeProfileId}
            onClaudeProfileChange={onClaudeProfileChange}
            queue={queue}
            keepGoing={keepGoing}
            onKeepGoingChange={onKeepGoingChange}
            onKeepGoingStop={onKeepGoingStop}
            onOpenWorktree={onOpenWorktree}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            {capabilitiesOf(backend).usage && usage.quota && (
              <QuotaChip quota={usage.quota} />
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                appendImages(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <button
              type="button"
              title="Attach image"
              onClick={() => fileRef.current?.click()}
              disabled={exited}
              className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <ImagePlus className="size-4" />
            </button>
            {busy && (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={onStop}
                title="Stop"
                className="rounded-full"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            )}
            {/* The shared primary button, not a hand-rolled circle: the
                composer's most-used control was the one place missing the
                press-scale and the ember shadow every other primary has. */}
            <Button
              type="button"
              size="icon"
              onClick={submit}
              title={busy ? "Queue message" : "Send"}
              disabled={(!input.trim() && images.length === 0) || exited}
              className="rounded-full"
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Session strip. The branch you are on and how full the window is
          describe the run, not the message being written — they were competing
          for room with send inside the input. Its own quieter box under it,
          rendered only when it has something to say. */}
      {hasStrip && (
        // A centred shelf slightly narrower than the input, tucked behind its
        // rounded bottom edge: the negative margin is covered by the composer's
        // own opaque surface, so the two read as one object without the input
        // giving up its corners.
        <div className="relative z-0 -mt-3 mx-auto flex w-[95%] items-center gap-3 rounded-b-xl border border-border/60 bg-card/40 px-2 pb-1 pt-4">
          <BranchChip cwd={cwd} busy={busy} compact />
          {capabilitiesOf(backend).usage && (
            <ContextMeter
              contextTokens={usage.contextTokens}
              model={model}
              backend={backend}
              resolved={usage.model}
              contextWindow={usage.contextWindow}
              onCompact={canCompact ? onCompact : undefined}
              compactDisabled={!!compactBlocked}
              compactDisabledReason={compactBlocked}
              compact
              className="ml-auto"
            />
          )}
        </div>
      )}
    </>
  );
});

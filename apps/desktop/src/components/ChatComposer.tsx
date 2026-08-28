import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Forward,
  Gauge,
  GitBranch,
  Lock,
  Minimize2,
  Pause,
  PencilLine,
  Play,
  Square,
  Unlock,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MentionMenu } from "@/components/MentionMenu";
import { SlashMenu } from "@/components/SlashMenu";
import { fuzzyFilter } from "@/lib/fuzzy";
import { contextWindowFor } from "@/lib/pricing";
import { formatPlan, formatResetsIn, formatWindowLength } from "@/lib/quota";
import {
  CLAUDE_EFFORTS,
  COMMAND_SIGIL,
  capabilitiesOf,
  type AgentBackend,
} from "@/lib/agentBackend";
import type { ClaudeProfile } from "@/lib/settings";
import {
  codexDefaultEffort,
  codexEfforts,
  titleCase,
} from "@/lib/codex/models";
import { applyMention, mentionAt, type Mention } from "@/lib/mentions";
import {
  compactDisabledReason,
  formatResumeCompactionQuestion,
  shouldOfferResumeCompaction,
} from "@/lib/compact";
import { pasteInsertion } from "@/lib/fileRef";
import { applySlash, filterCommands, slashAt, type SlashToken } from "@/lib/slash";
import {
  useCodexModels,
  useGitBranch,
  useGitBranches,
  useInvalidateGit,
  useProjectFiles,
  useSlashCommands,
} from "@/lib/queries";
import { ModelPicker } from "@/components/ModelPicker";
import { cn } from "@/lib/utils";
import type { PromptQueue } from "@/lib/promptQueue";
import type { ChatImage, ChatQuota, ChatUsage } from "@/hooks/useAgentChat";

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

/** Trigger styling shared by the access/mode chips — matches ModelPicker. */
const chipTrigger =
  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-white/[0.04] hover:text-primary focus-visible:ring-1 focus-visible:ring-ring";

interface EffortPickerProps {
  /** Selected model, which for Codex decides the levels on offer. */
  model: string;
  /** Selected level; "" leaves it to the CLI. */
  effort: string;
  backend: AgentBackend;
  cwd: string;
  usage: ChatUsage;
  onEffortChange: (effort: string) => void;
}

/** Reasoning effort, chosen independently of the model. Both CLIs take it as
 *  their own parameter — Claude as a spawn-time `--effort`, Codex per turn —
 *  so it gets its own chip rather than multiplying the model menu. */
const EffortPicker = memo(function EffortPicker({
  model,
  effort,
  backend,
  cwd,
  usage,
  onEffortChange,
}: EffortPickerProps) {
  const codex = backend === "codex";
  const models = useCodexModels(cwd, codex).data ?? [];
  // Codex: on "Default" the levels on offer are those of the model the CLI
  // resolved. Claude: the same five levels whatever the model, so no catalog.
  const source = model || usage.model || "";
  const efforts = codex ? codexEfforts(source, models) : CLAUDE_EFFORTS;
  if (efforts.length === 0) return null;
  const fallback = codex ? codexDefaultEffort(source, models) : undefined;
  const level = titleCase(effort || fallback || "") || "Default";
  // The window rides along on this chip: it is the other half of "how hard is
  // this turn going to think", and it saves a second control for one number.
  const max = resolveContextWindow(model, backend, usage.model, usage.contextWindow);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        <span>{max > 0 ? `${level} · ${fmtTokens(max).toUpperCase()}` : level}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36">
        <DropdownMenuItem
          onSelect={() => onEffortChange("")}
          className="justify-between gap-4"
        >
          {fallback ? `Default (${titleCase(fallback)})` : "Default"}
          {effort === "" && <Check className="size-3.5" />}
        </DropdownMenuItem>
        {efforts.map((e) => (
          <DropdownMenuItem
            key={e}
            onSelect={() => onEffortChange(e)}
            className="justify-between gap-4"
          >
            {titleCase(e)}
            {e === effort && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

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
          <Unlock className="size-4 shrink-0 text-primary" />
        ) : (
          <Lock className="size-4 shrink-0 opacity-70" />
        )}
        <span>{fullAccess ? "Full access" : "Supervised"}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
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

const ClaudeProfileChip = memo(function ClaudeProfileChip({
  profiles,
  profileId,
  onChange,
}: {
  profiles: ClaudeProfile[];
  profileId: string | null;
  onChange?: (id: string | null) => void;
}) {
  const current = profiles.find((p) => p.id === profileId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        <span>{current?.name ?? "Claude"}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem
          onSelect={() => onChange?.(null)}
          className="justify-between gap-4"
        >
          Claude
          {!profileId && <Check className="size-3.5" />}
        </DropdownMenuItem>
        {profiles.map((profile) => (
          <DropdownMenuItem
            key={profile.id}
            onSelect={() => onChange?.(profile.id)}
            className="justify-between gap-4"
          >
            {profile.name}
            {profileId === profile.id && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Current branch, click to checkout another local one. Hidden when the cwd
 *  isn't a git repo. */
const BranchChip = memo(function BranchChip({
  cwd,
  busy,
}: {
  cwd: string;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const branch = useGitBranch(cwd).data?.branch;
  const branches = useGitBranches(cwd, open).data ?? [];
  const invalidateGit = useInvalidateGit();

  if (!branch) return null;

  const checkout = async (name: string) => {
    if (name === branch) return;
    if (busy) {
      const ok = await ask(
        `A turn is in progress. Switch to branch "${name}" anyway?`,
        { title: "Switch branch", kind: "warning" },
      );
      if (!ok) return;
    }
    try {
      await invoke<string>("git_checkout", {
        path: cwd,
        branch: name,
        create: false,
      });
      invalidateGit(cwd);
    } catch (e) {
      toast.error("Checkout failed", { description: String(e) });
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className={chipTrigger} title={`On branch ${branch}`}>
        <GitBranch className="size-4 shrink-0 opacity-70" />
        <span className="max-w-32 truncate">{branch}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-auto">
        <DropdownMenuLabel>Checkout</DropdownMenuLabel>
        {branches.map((name) => (
          <DropdownMenuItem
            key={name}
            disabled={name === branch}
            onSelect={() => void checkout(name)}
            className="justify-between gap-4"
          >
            <span className="truncate">{name}</span>
            {name === branch && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Context-window size for the running session. The `[1m]` alias opts into the
 *  1M beta explicitly; otherwise use the model the CLI actually resolved (the
 *  alias may be "" or a family name the catalog doesn't know) and fall back to
 *  the 200k every Claude model has at minimum. */
const resolveContextWindow = (
  model: string,
  backend: AgentBackend,
  resolved?: string,
  reported?: number
): number => {
  // A window the backend states beats anything inferred from the model id.
  // Codex sends one per turn; the LiteLLM catalog only knows Claude keys, so
  // without this a Codex ring divides by zero and reads as permanently full.
  if (reported && reported > 0) return reported;
  if (model.includes("[1m]")) return 1_000_000;
  const known = contextWindowFor(resolved || model);
  if (known) return known;
  // 200k is Claude's floor, not a universal one.
  return backend === "claude" ? 200_000 : 0;
};

/** Compact token count: 135k, 1m. */
const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`
    : `${Math.round(n / 1000)}k`;

const RING = 2 * Math.PI * 10; // r=10 in a 24 viewBox — matches the send button.

/** Ring gauge beside the send button; its popover shows how full the context
 *  window is. Kept its own memo so typing never re-renders the SVG. */
const ContextMeter = memo(function ContextMeter({
  contextTokens,
  model,
  backend,
  resolved,
  contextWindow,
  onCompact,
  compactDisabled,
  compactDisabledReason: disabledReason,
}: {
  contextTokens?: number;
  model: string;
  backend: AgentBackend;
  resolved?: string;
  contextWindow?: number;
  onCompact?: () => void;
  compactDisabled?: boolean;
  compactDisabledReason?: string | null;
}) {
  const max = resolveContextWindow(model, backend, resolved, contextWindow);
  const used = contextTokens ?? 0;
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const overloaded = pct > 90;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title="Context window"
        className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:text-foreground"
      >
        <svg viewBox="0 0 24 24" className="size-8 -rotate-90">
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            strokeWidth="2"
            className="stroke-muted-foreground/25"
          />
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - pct / 100)}
            className={
              overloaded
                ? "stroke-destructive transition-[stroke-dashoffset]"
                : "stroke-primary transition-[stroke-dashoffset]"
            }
          />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Context Window</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {max > 0 ? `${pct}% · ${fmtTokens(used)}/${fmtTokens(max)}` : fmtTokens(used)}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={
              overloaded
                ? "h-full rounded-full bg-destructive transition-[width]"
                : "h-full rounded-full bg-primary transition-[width]"
            }
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {backend === "claude" ? "Claude" : "Codex"} automatically compacts its
          context when needed.
        </p>
        {onCompact && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              disabled={compactDisabled}
              onClick={onCompact}
            >
              <Minimize2 className="size-3.5" />
              Compact context
            </Button>
            {compactDisabled && disabledReason && (
              <p className="mt-1.5 text-xs text-muted-foreground">{disabledReason}</p>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Plan quota for backends that report one. The trigger carries the tightest
 *  window's used share; the popover breaks every window out. */
const QuotaChip = memo(function QuotaChip({ quota }: { quota: ChatQuota }) {
  const windows = [
    { key: "primary", window: quota.primary },
    { key: "secondary", window: quota.secondary },
  ].flatMap((w) => (w.window ? [{ key: w.key, ...w.window }] : []));
  if (!windows.length) return null;
  const now = Date.now();
  const plan = formatPlan(quota.planType);
  const lead = Math.min(100, Math.round(Math.max(...windows.map((w) => w.usedPercent))));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger} title="Usage limit">
        <Gauge className="size-4 shrink-0 opacity-70" />
        <span className="font-mono tabular-nums">{lead}%</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-64 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">Usage Limit</span>
          {plan && (
            <span className="font-mono text-xs text-muted-foreground">{plan}</span>
          )}
        </div>
        {windows.map((w) => {
          const pct = Math.min(100, Math.round(w.usedPercent));
          const resets = formatResetsIn(w.resetsAt, now);
          const length = formatWindowLength(w.windowDurationMins);
          return (
            <div key={w.key} className="mt-2">
              <div className="flex items-center justify-between gap-2 font-mono text-xs tabular-nums text-muted-foreground">
                <span>{length || "Window"}</span>
                <span>
                  {pct}%{resets ? ` · ${resets}` : ""}
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Runtime-owned prompt queue manager: shows queued turns and lets the user
 *  reorder, edit, delete, pause/resume, or run the next one immediately. */
function QueueChip({ queued, queue }: { queued: number; queue: PromptQueue }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const submitEdit = (queueId: string) => {
    if (text.trim()) void queue.edit(queueId, text.trim());
    setEditing(null);
    setText("");
  };
  const runNext = () => void queue.resume().then(() => queue.runNext());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        {queue.paused ? (
          <Pause className="size-4 shrink-0 opacity-70" />
        ) : (
          <Clock className="size-4 shrink-0 opacity-70" />
        )}
        <span>{queued} queued</span>
        {queue.paused && <span className="text-xs text-amber-400">paused</span>}
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
          <span className="text-xs font-medium text-foreground">
            Prompt queue
            {queue.paused && <span className="ml-1.5 text-amber-400">· paused</span>}
          </span>
          <div className="flex items-center gap-1">
            {queue.paused ? (
              <DropdownMenuItem
                onSelect={() => void queue.resume()}
                className="justify-between gap-3 text-xs"
              >
                <Play className="size-3" /> Resume
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onSelect={() => void queue.pause()}
                className="justify-between gap-3 text-xs"
              >
                <Pause className="size-3" /> Pause
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={runNext}
              className="justify-between gap-3 text-xs"
            >
              <Forward className="size-3" /> Run next now
            </DropdownMenuItem>
          </div>
        </div>
        <div className="flex max-h-56 flex-col overflow-y-auto">
          {queue.items.length === 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">Queue is empty.</div>
          )}
          {queue.items.map((p, i) => (
            <div
              key={p.queueId}
              className="flex items-start gap-1 border-b border-border/50 px-2 py-1.5 last:border-0"
            >
              {editing === p.queueId ? (
                <div className="flex flex-1 items-center gap-1">
                  <Input
                    autoFocus
                    value={text}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter") submitEdit(p.queueId);
                      if (e.key === "Escape") setEditing(null);
                    }}
                    className="h-7 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => submitEdit(p.queueId)}
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    <Check className="size-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-foreground" title={p.text}>
                      {p.text}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[0.65rem] text-muted-foreground">
                        #{i + 1}
                      </span>
                      {i === 0 && !queue.paused && (
                        <span className="text-[0.65rem] text-emerald-400">next</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(p.queueId);
                        setText(p.text);
                      }}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <PencilLine className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => void queue.reorder(i, i - 1)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={i === queue.items.length - 1}
                      onClick={() => void queue.reorder(i, i + 1)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronDown className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void queue.remove(p.queueId)}
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-red-400"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface UsageFooterProps {
  /** Turns typed while busy and not yet sent. */
  queued: number;
  backend: AgentBackend;
  cwd: string;
  usage: ChatUsage;
  /** Selected `--model` alias; "" = default. */
  model: string;
  onModelChange: (model: string) => void;
  /** Selected reasoning effort; "" = let the CLI decide. */
  effort: string;
  onEffortChange: (effort: string) => void;
  fullAccess: boolean;
  onFullAccessChange: (v: boolean) => void;
  /** Move the thread to another provider in place — picking a model that
   *  belongs to one is how that happens. */
  onSwitchBackend: (backend: AgentBackend) => void;
  claudeProfiles: ClaudeProfile[];
  claudeProfileId: string | null;
  onClaudeProfileChange?: (id: string | null) => void;
  /** Runtime-owned prompt queue; null when the backend has none (Codex steers). */
  queue?: PromptQueue | null;
}

/** Token/cost telemetry restated on every message_delta. Split out so that
 *  churn re-renders this row alone, and so typing (which changes the composer's
 *  draft state, not the usage) skips it. */
const UsageFooter = memo(function UsageFooter({
  queued,
  backend,
  cwd,
  usage,
  model,
  onModelChange,
  effort,
  onEffortChange,
  fullAccess,
  onFullAccessChange,
  onSwitchBackend,
  claudeProfiles,
  claudeProfileId,
  onClaudeProfileChange,
  queue,
}: UsageFooterProps) {
  return (
    <div className="flex min-w-max flex-nowrap items-center gap-3 text-xs text-muted-foreground">
      {queued > 0 && queue && (
        <QueueChip queued={queued} queue={queue} />
      )}
      <ModelPicker
        model={model}
        effort={effort}
        backend={backend}
        cwd={cwd}
        usage={usage}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        onSwitchBackend={onSwitchBackend}
      />
      {capabilitiesOf(backend).reasoningEffort && (
        <EffortPicker
          model={model}
          effort={effort}
          backend={backend}
          cwd={cwd}
          usage={usage}
          onEffortChange={onEffortChange}
        />
      )}
      {capabilitiesOf(backend).permissions && (
        <AccessChip fullAccess={fullAccess} onChange={onFullAccessChange} />
      )}
      {backend === "claude" && claudeProfiles.length > 0 && (
        <ClaudeProfileChip
          profiles={claudeProfiles}
          profileId={claudeProfileId}
          onChange={onClaudeProfileChange}
        />
      )}
    </div>
  );
});

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
  fullAccess: boolean;
  onFullAccessChange: (v: boolean) => void;
  /** Move the thread to another provider in place. */
  onSwitchBackend: (backend: AgentBackend) => void;
  /** Extra named Claude setups. Empty = the default Claude only. */
  claudeProfiles?: ClaudeProfile[];
  claudeProfileId?: string | null;
  onClaudeProfileChange?: (id: string | null) => void;
  /** Runtime-owned prompt queue for reorder/edit/delete/pause/run-next. */
  queue?: PromptQueue | null;
  /** Text handed to this chat from elsewhere, to drop into the box unsent. */
  draft?: string;
  onDraftConsumed: () => void;
  onSend: (text: string, images: ChatImage[]) => void;
  /** Compact the live context window. Absent when this backend cannot. */
  onCompact?: () => void;
  /** Wall-clock of the newest turn, for the idle-session compact ask. */
  lastActivityAt?: number;
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
  fullAccess,
  onFullAccessChange,
  onSwitchBackend,
  claudeProfiles = [],
  claudeProfileId = null,
  onClaudeProfileChange,
  queue,
  draft,
  onDraftConsumed,
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
            "chat-composer-surface overflow-hidden rounded-3xl border transition-colors focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/40",
           dragging && "border-ring ring-1 ring-ring/50"
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
                  onClick={() => onPreview(imageSrc(img))}
                  className="block size-full"
                >
                  <img src={imageSrc(img)} alt="" className="size-full object-cover" />
                </button>
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
                   : "Ask for changes, send follow-ups, or attach images"
          }
          disabled={!ready || exited}
          rows={1}
          // `block` overrides the shadcn base's `flex`: as a flex container the
          // textarea's inner editor gets a min-content floor, so one long
          // unbreakable token (an @path mention) pushes the line wider than the
          // box instead of wrapping. `break-words` wraps the token itself.
           className="block max-h-40 min-h-24 resize-none overscroll-contain overflow-x-hidden overflow-y-auto break-words border-0 bg-transparent px-5 pb-1 pt-5 text-[15px] leading-6 shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0"
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
          <div className="composer-controls-scroll flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-x-auto overscroll-contain pb-4 pl-2.5 pr-4 pt-2">
          <UsageFooter
            queued={queued}
            backend={backend}
            cwd={cwd}
            usage={usage}
            model={model}
            onModelChange={onModelChange}
            effort={effort}
            onEffortChange={onEffortChange}
            fullAccess={fullAccess}
            onFullAccessChange={onFullAccessChange}
            onSwitchBackend={onSwitchBackend}
            claudeProfiles={claudeProfiles}
            claudeProfileId={claudeProfileId}
            onClaudeProfileChange={onClaudeProfileChange}
            queue={queue}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <BranchChip cwd={cwd} busy={busy} />
            {capabilitiesOf(backend).usage && (
              <>
                <ContextMeter
                  contextTokens={usage.contextTokens}
                  model={model}
                  backend={backend}
                  resolved={usage.model}
                  contextWindow={usage.contextWindow}
                  onCompact={canCompact ? onCompact : undefined}
                  compactDisabled={!!compactBlocked}
                  compactDisabledReason={compactBlocked}
                />
                {usage.quota && <QuotaChip quota={usage.quota} />}
              </>
            )}
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

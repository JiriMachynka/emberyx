import { memo } from "react";
import { Check, ChevronDown, Lock, Unlock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModelPicker } from "@/components/ModelPicker";
import {
  CLAUDE_EFFORTS,
  capabilitiesOf,
  isAcpBackend,
  type AgentBackend,
} from "@/lib/agentBackend";
import {
  ACCESS_LEVELS,
  ACCESS_LEVEL_LABEL,
  type AccessLevel,
  type ClaudeProfile,
} from "@/lib/settings";
import {
  codexDefaultEffort,
  codexEfforts,
  titleCase,
} from "@/lib/codex/models";
import { useCodexModels } from "@/lib/queries";
import type { PromptQueue } from "@/lib/promptQueue";
import type { ChatUsage } from "@/hooks/useAgentChat";
import { chipTrigger } from "@/components/composer/chipStyles";
import { fmtTokens, resolveContextWindow } from "@/components/composer/ContextMeter";
import { QueueChip } from "@/components/composer/QueueChip";
import { KeepGoingChip } from "@/components/composer/KeepGoingChip";
import type { KeepGoing } from "@/lib/keepGoing";

interface EffortPickerProps {
  /** Selected model, which for Codex decides the levels on offer. */
  model: string;
  /** Selected level; "" leaves it to the CLI. */
  effort: string;
  backend: AgentBackend;
  cwd: string;
  /** Only the two fields this chip reads. `usage` is a fresh object on every
   *  streamed frame, so taking the whole thing re-renders the chip per frame. */
  resolvedModel?: string;
  contextWindow?: number;
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
  resolvedModel,
  contextWindow,
  onEffortChange,
}: EffortPickerProps) {
  const codex = backend === "codex";
  const models = useCodexModels(cwd, codex).data ?? [];
  // Codex: on "Default" the levels on offer are those of the model the CLI
  // resolved. Claude: the same five levels whatever the model, so no catalog.
  const source = model || resolvedModel || "";
  const efforts = codex ? codexEfforts(source, models) : CLAUDE_EFFORTS;
  if (efforts.length === 0) return null;
  const fallback = codex ? codexDefaultEffort(source, models) : undefined;
  const level = titleCase(effort || fallback || "") || "Default";
  // The window rides along on this chip: it is the other half of "how hard is
  // this turn going to think", and it saves a second control for one number.
  const max = resolveContextWindow(model, backend, resolvedModel, contextWindow);
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

/** How much the agent may do without asking. One control for what Claude
 *  splits into `--permission-mode` and `--dangerously-skip-permissions`; the
 *  split happens at spawn, not here. Full access is the only unlocked posture,
 *  so it is the only one that gets the accent. */
const AccessChip = memo(function AccessChip({
  access,
  onChange,
  jev,
}: {
  access: AccessLevel;
  onChange: (v: AccessLevel) => void;
  /** ACP only: TypeSafe Jev auto-answers low-risk prompts. */
  jev?: { enabled: boolean; onChange: (v: boolean) => void };
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={chipTrigger}>
        {access === "full" ? (
          <Unlock className="size-4 shrink-0 text-primary" />
        ) : (
          <Lock className="size-4 shrink-0 opacity-70" />
        )}
        <span>{ACCESS_LEVEL_LABEL[access]}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {ACCESS_LEVELS.map((level) => (
          <DropdownMenuItem
            key={level}
            onSelect={() => onChange(level)}
            className="justify-between gap-4"
          >
            {ACCESS_LEVEL_LABEL[level]}
            {access === level && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
        {jev && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                jev.onChange(!jev.enabled);
              }}
              className="justify-between gap-4"
            >
              Jev judgments
              {jev.enabled && <Check className="size-3.5" />}
            </DropdownMenuItem>
          </>
        )}
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
  access: AccessLevel;
  onAccessChange: (v: AccessLevel) => void;
  jevAutoApprove?: boolean;
  onJevAutoApproveChange?: (v: boolean) => void;
  /** Move the thread to another provider in place — picking a model that
   *  belongs to one is how that happens. */
  onSwitchBackend: (backend: AgentBackend) => void;
  claudeProfiles: ClaudeProfile[];
  claudeProfileId: string | null;
  onClaudeProfileChange?: (id: string | null) => void;
  /** Runtime-owned prompt queue; null when the backend has none (Codex steers). */
  queue?: PromptQueue | null;
  keepGoing?: KeepGoing;
  onKeepGoingChange?: (next: KeepGoing | undefined) => void;
  onKeepGoingStop?: () => void;
  onOpenWorktree?: (path: string, repoRoot: string, branch: string) => void;
}

/** Token/cost telemetry restated on every message_delta. Split out so that
 *  churn re-renders this row alone, and so typing (which changes the composer's
 *  draft state, not the usage) skips it. */
export const UsageFooter = memo(function UsageFooter({
  queued,
  backend,
  cwd,
  usage,
  model,
  onModelChange,
  effort,
  onEffortChange,
  access,
  onAccessChange,
  jevAutoApprove = true,
  onJevAutoApproveChange,
  onSwitchBackend,
  claudeProfiles,
  claudeProfileId,
  onClaudeProfileChange,
  queue,
  keepGoing,
  onKeepGoingChange,
  onKeepGoingStop,
  onOpenWorktree,
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
        sessionModels={usage.models}
        resolvedModel={usage.model}
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
          resolvedModel={usage.model}
          contextWindow={usage.contextWindow}
          onEffortChange={onEffortChange}
        />
      )}
      {capabilitiesOf(backend).permissions && (
        <AccessChip
          access={access}
          onChange={onAccessChange}
          jev={
            isAcpBackend(backend) && onJevAutoApproveChange
              ? { enabled: jevAutoApprove, onChange: onJevAutoApproveChange }
              : undefined
          }
        />
      )}
      {/* Continue-on-idle lives in the Claude hook; askUser is the same gate. */}
      {onKeepGoingChange && capabilitiesOf(backend).askUser && (
        <KeepGoingChip
          flag={keepGoing}
          usage={usage}
          cwd={cwd}
          onChange={onKeepGoingChange}
          onStop={onKeepGoingStop ?? (() => {})}
          onAccessFull={() => onAccessChange("full")}
          onOpenWorktree={onOpenWorktree}
        />
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

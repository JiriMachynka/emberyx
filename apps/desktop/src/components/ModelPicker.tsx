import { memo, useMemo, useState } from "react";
import { ChevronRight, ChevronsUpDown, Search, Star } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BACKEND_LABEL, isAgentBackend, type AgentBackend } from "@/lib/agentBackend";
import { PROVIDERS, PROVIDER_LABEL, type Provider } from "@/lib/providers";
import {
  CLAUDE_MODELS,
  acpModelEntries,
  codexModelEntries,
  labelForModel,
  orderByFavorites,
  searchModels,
  type ModelEntry,
} from "@/lib/modelCatalog";
import { getFavorites, shortcutFor, toggleFavorite } from "@/lib/modelFavorites";
import { codexEffortForModel } from "@/lib/codex/models";
import { useAcpModels, useCodexModels, useProviderStatus } from "@/lib/queries";
import type { ChatUsage } from "@/hooks/useAgentChat";

/** The rail's first entry: whatever the user starred, across providers. */
const FAVORITES = "favorites" as const;
type Rail = typeof FAVORITES | Provider;

/** Providers whose models Emberyx can actually enumerate. Claude's list is
 *  hand-written (the CLI has none to ask); Codex's comes off its app-server;
 *  the ACP providers answer with theirs on `session/new`, read here from a
 *  throwaway session. */
const isLiveProvider = (p: Provider) => isAgentBackend(p);

interface ModelPickerProps {
  /** Selected `--model` value for this session; "" = let the CLI decide. */
  model: string;
  /** Selected reasoning effort, so a Codex switch can drop one the target
   *  model doesn't offer. */
  effort: string;
  /** Provider the chat is running on right now. */
  backend: AgentBackend;
  /** Project root — a Codex catalog lookup needs one to open an app-server. */
  cwd: string;
  usage: ChatUsage;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  /** Move the thread to another provider in place. Called before the model
   *  change when the picked model belongs to someone else. */
  onSwitchBackend: (backend: AgentBackend) => void;
}

const ProviderIcon = ({ provider, className }: { provider: string; className?: string }) => (
  <img src={`/provider-icons/${provider}.svg`} alt="" className={cn("shrink-0 object-contain", className)} />
);

/**
 * The model list: a provider rail on the left, a searchable list on the right.
 *
 * Picking a model is also how a thread changes provider — the entry knows whose
 * it is, so a Codex model chosen in a Claude chat switches the transport in
 * place and then sets the model. ACP providers expose a provider-only default
 * until their model catalog can be enumerated.
 */
export const ModelPicker = memo(function ModelPicker({
  model,
  effort,
  backend,
  cwd,
  usage,
  onModelChange,
  onEffortChange,
  onSwitchBackend,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  // A chat on a provider with no catalog would otherwise open on an empty list.
  const [rail, setRail] = useState<Rail>(() =>
    isLiveProvider(backend) ? backend : FAVORITES
  );
  const [query, setQuery] = useState("");
  const [showLegacy, setShowLegacy] = useState(false);
  const [favorites, setFavorites] = useState(getFavorites);

  const installed = useProviderStatus().data ?? [];
  // Opening an app-server to read the catalog is real work — only when Codex
  // models can actually appear: this chat is on Codex, the Codex rail is
  // showing, or Favourites includes an id that isn't in Claude's list.
  const wantsCodex =
    backend === "codex" ||
    rail === "codex" ||
    (rail === FAVORITES &&
      favorites.some((id) => !CLAUDE_MODELS.some((m) => m.id === id)));
  const codexCatalog = useCodexModels(cwd, wantsCodex && open);
  const codexModels = useMemo(() => codexCatalog.data ?? [], [codexCatalog.data]);
  // The ACP catalogs are read just as lazily — each needs a throwaway agent
  // session — and only when that provider's rail is showing. The provider a
  // live chat runs on already carries its list in `usage.models`, so it is
  // never probed a second time.
  const wantsGrok =
    rail === "grok" && backend !== "grok" && installed.some((s) => s.id === "grok" && s.installed);
  const wantsOpencode =
    rail === "opencode" &&
    backend !== "opencode" &&
    installed.some((s) => s.id === "opencode" && s.installed);
  const grokCatalog = useAcpModels("grok", cwd, wantsGrok && open);
  const opencodeCatalog = useAcpModels("opencode", cwd, wantsOpencode && open);

  const all = useMemo<ModelEntry[]>(() => {
    const entries = [
      ...CLAUDE_MODELS,
      ...codexModelEntries(codexModels),
      ...acpModelEntries("grok", grokCatalog.data ?? []),
      ...acpModelEntries("opencode", opencodeCatalog.data ?? []),
      ...(usage.models ?? []).map((entry) => ({
        id: entry.value,
        label: entry.label,
        provider: backend,
        legacy: false,
      })),
    ];
    // A cached ACP catalog and the live chat's `usage.models` name the same
    // models; each id renders once, first entry wins.
    const seen = new Set<string>();
    return entries.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }, [backend, codexModels, grokCatalog.data, opencodeCatalog.data, usage.models]);

  const shown = useMemo(() => {
    const scoped =
      rail === FAVORITES
        ? all.filter((e) => favorites.includes(e.id))
        : all.filter((e) => e.provider === rail);
    return orderByFavorites(searchModels(scoped, query), favorites);
  }, [all, favorites, query, rail]);

  const current = shown.filter((e) => !e.legacy);
  const legacy = shown.filter((e) => e.legacy);

  const select = (entry: ModelEntry) => {
    if (entry.provider !== backend) onSwitchBackend(entry.provider);
    onModelChange(entry.id);
    if (entry.provider === "codex") {
      const kept = codexEffortForModel(entry.id, effort, codexModels);
      if (kept !== effort) onEffortChange(kept);
    }
    setOpen(false);
  };

  const selectDefault = () => {
    if (isAgentBackend(rail) && rail !== backend) onSwitchBackend(rail);
    onModelChange("");
    setOpen(false);
  };

  const star = (id: string) => setFavorites(toggleFavorite(id));

  // ⌘1…⌘9 pick off the visible list, which is the order the badges number.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.metaKey && !e.ctrlKey) return;
    const at = Number(e.key) - 1;
    if (Number.isNaN(at) || at < 0 || at > 8) return;
    const entry = current[at];
    if (!entry) return;
    e.preventDefault();
    select(entry);
  };

  // The CLI-resolved model when nothing is pinned, so the chip still names what
  // is actually running.
  const resolved = usage.model ? labelForModel(usage.model, all) ?? usage.model : "";
  const label = model ? labelForModel(model, all) ?? model : resolved || "Default";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The chip names the live backend; snap the rail to match so a silent
        // picker switch doesn't leave the list on whoever was showing last.
        if (next) setRail(isLiveProvider(backend) ? backend : FAVORITES);
      }}
    >
      <PopoverTrigger className={TRIGGER}>
        <ProviderIcon provider={backend} className="size-4" />
        <span className="truncate">{label}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent className="flex h-96 w-[26rem] p-0" onKeyDown={onKeyDown}>
        <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-secondary/20 py-2">
          <RailButton
            active={rail === FAVORITES}
            title="Favorites"
            onClick={() => setRail(FAVORITES)}
          >
            <Star
              className={cn("size-6", rail === FAVORITES ? "text-primary" : "opacity-70")}
            />
          </RailButton>
          {PROVIDERS.filter((p) => installed.some((s) => s.id === p && s.installed)).map(
            (provider) => {
              const listable = isLiveProvider(provider);
              return (
                <RailButton
                  key={provider}
                  active={rail === provider}
                  disabled={!listable}
                  title={
                    listable
                      ? PROVIDER_LABEL[provider]
                      : `${PROVIDER_LABEL[provider]} — not available in chat`
                  }
                  onClick={() => setRail(provider)}
                >
                  <ProviderIcon provider={provider} className="size-6" />
                </RailButton>
              );
            }
          )}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {rail !== FAVORITES && !query && (
              <Row
                title={resolved ? `Default (${resolved})` : "Default"}
                subtitle={`${BACKEND_LABEL[isAgentBackend(rail) ? rail : backend]} decides`}
                provider={isAgentBackend(rail) ? rail : backend}
                selected={model === ""}
                onSelect={selectDefault}
              />
            )}

            {current.map((entry, i) => (
              <Row
                key={entry.id}
                title={entry.label}
                subtitle={BACKEND_LABEL[entry.provider]}
                provider={entry.provider}
                shortcut={shortcutFor(i) ?? undefined}
                selected={entry.id === model}
                starred={favorites.includes(entry.id)}
                onStar={() => star(entry.id)}
                onSelect={() => select(entry)}
              />
            ))}

            {current.length === 0 && (
              <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                {rail === FAVORITES
                  ? "Star a model to keep it here"
                  : (wantsCodex && codexCatalog.isPending) ||
                      (wantsGrok && grokCatalog.isPending) ||
                      (wantsOpencode && opencodeCatalog.isPending)
                    ? "Reading the catalog…"
                    : "No models match"}
              </p>
            )}

            {legacy.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowLegacy((v) => !v)}
                  className="mt-1 flex w-full items-center gap-2 rounded-lg bg-secondary/40 px-3 py-2.5 text-left transition-colors hover:bg-secondary/70"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      Legacy models
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {legacy.length} model{legacy.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <ChevronRight
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      showLegacy && "rotate-90"
                    )}
                  />
                </button>
                {showLegacy &&
                  legacy.map((entry) => (
                    <Row
                      key={entry.id}
                      title={entry.label}
                      subtitle={BACKEND_LABEL[entry.provider]}
                      provider={entry.provider}
                      selected={entry.id === model}
                      starred={favorites.includes(entry.id)}
                      onStar={() => star(entry.id)}
                      onSelect={() => select(entry)}
                    />
                  ))}
              </>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
});

/** Trigger styling shared with the composer's other chips. */
const TRIGGER =
  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground outline-none transition-colors hover:bg-white/[0.04] hover:text-primary focus-visible:ring-1 focus-visible:ring-ring";

function RailButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative grid size-10 place-items-center rounded-lg transition-colors",
        disabled
          ? "cursor-not-allowed opacity-30"
          : active
            ? "bg-secondary"
            : "hover:bg-secondary/60"
      )}
    >
      {active && !disabled && (
        <span className="absolute -left-2 h-6 w-0.5 rounded-full bg-primary" />
      )}
      {children}
    </button>
  );
}

function Row({
  title,
  subtitle,
  provider,
  shortcut,
  selected,
  starred,
  onStar,
  onSelect,
}: {
  title: string;
  subtitle: string;
  provider: string;
  shortcut?: string;
  selected: boolean;
  starred?: boolean;
  onStar?: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "group/model flex items-center gap-2 rounded-lg px-3 py-2 transition-colors",
        selected ? "bg-secondary" : "hover:bg-secondary/50"
      )}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon provider={provider} className="size-3" />
          {subtitle}
        </span>
      </button>
      {shortcut && (
        <kbd className="shrink-0 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {shortcut}
        </kbd>
      )}
      {onStar && (
        <button
          type="button"
          onClick={onStar}
          title={starred ? "Unstar" : "Star"}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Star className={cn("size-3.5", starred && "fill-primary text-primary")} />
        </button>
      )}
    </div>
  );
}

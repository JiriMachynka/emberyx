import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDER_LABEL, type ProviderStatus } from "@/lib/providers";
import {
  CODEX_SANDBOXES,
  CODEX_SANDBOX_LABEL,
  isCodexSandbox,
} from "@/lib/settings";
import {
  getCustomModels,
  getHiddenModels,
  setCustomModels,
  setHiddenModels,
} from "@/lib/modelFavorites";
import { Field, Group, Row, Tile } from "@/components/SettingsFields";
import {
  AGENT_BACKENDS,
  BACKEND_LABEL,
  isAgentBackend,
  type AgentBackend,
} from "@/lib/agentBackend";
import { LaunchEnvRows } from "./LaunchEnvRows";
import type { Settings } from "@/lib/settings";

export const ProvidersSection = ({
  settings,
  onUpdate,
  providers,
  hiddenDraft,
  setHiddenDraft,
  customBackend,
  setCustomBackend,
  customDraft,
  setCustomDraft,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  providers: ProviderStatus[];
  hiddenDraft: string;
  setHiddenDraft: (value: string) => void;
  customBackend: AgentBackend;
  setCustomBackend: (value: AgentBackend) => void;
  customDraft: string;
  setCustomDraft: (value: string) => void;
}) => {
  // Out of the React Compiler, as this JSX was while it rendered inline in
  // SettingsPage (which the compiler skips): the hidden and custom model lists
  // are read from localStorage during render, and a compiled component would
  // cache that read and never show a model you just hid or added.
  "use no memo";
  return (
    <>
      <Group
        title="Installed"
        hint="Detected from your login-shell PATH and each CLI's version probe. A provider that isn't installed is listed, not hidden — the absence is the useful part."
      >
        <div className="grid gap-1.5">
          {providers.map((p) => (
            <Tile
              key={p.id}
              icon={
                <img
                  src={`/provider-icons/${p.id}.svg`}
                  alt=""
                  className="size-5 shrink-0 object-contain"
                />
              }
              status={p.installed ? "on" : "off"}
              title={PROVIDER_LABEL[p.id] ?? p.label}
              meta={<code className="truncate">{p.binary}</code>}
              aside={
                p.installed ? p.version ?? "installed" : "not installed"
              }
            />
          ))}
        </div>
      </Group>

      <Group title="Defaults">
        <Row
          label="Default backend"
          hint="Which CLI the command drives. Projects can pin their own in the project's Settings tab."
          control={
            <Select
              value={settings.agentBackend}
              onValueChange={(v) => {
                if (isAgentBackend(v)) onUpdate({ agentBackend: v });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_BACKENDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {BACKEND_LABEL[b]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />

        <Row
          label="Agent command"
          hint="The agent CLI binary, e.g. claude or codex."
          control={
            <Input
              value={settings.agentCommand}
              onChange={(e) => onUpdate({ agentCommand: e.target.value })}
              spellCheck={false}
            />
          }
        />

        <Row
          label="Codex sandbox"
          hint="How much of the machine a Codex thread can touch. Default follows the switches above: full access when permissions are skipped, workspace writes otherwise."
          control={
            <Select
              value={settings.codexSandbox}
              onValueChange={(v) => {
                if (isCodexSandbox(v)) onUpdate({ codexSandbox: v });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODEX_SANDBOXES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {CODEX_SANDBOX_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </Group>

      <Group
        title="Model list"
        hint="What the composer's picker offers. Hidden models drop out of every rail; custom slugs join the provider you assign them to."
      >
        <Row
          label="Hidden models"
          hint="Model ids the picker never offers, whatever a catalog says."
          control={<span />}
        >
          <div className="flex items-center gap-1.5">
            <Input
              value={hiddenDraft}
              onChange={(e) => setHiddenDraft(e.target.value)}
              placeholder="provider/model-id"
              spellCheck={false}
              className="h-7 w-64 font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!hiddenDraft.trim()}
              onClick={() => {
                const id = hiddenDraft.trim();
                if (!id) return;
                setHiddenModels([...getHiddenModels(), id]);
                setHiddenDraft("");
              }}
            >
              Hide
            </Button>
          </div>
          {getHiddenModels().length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {getHiddenModels().map((id) => (
                <span
                  key={id}
                  className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                >
                  {id}
                  <button
                    type="button"
                    aria-label={`Unhide ${id}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setHiddenModels(getHiddenModels().filter((v) => v !== id))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </Row>

        <Row
          label="Custom models"
          hint="Extra slugs offered in the picker — new releases, proxies, private endpoints."
          control={<span />}
        >
          <div className="flex items-center gap-1.5">
            <Select
              value={customBackend}
              onValueChange={(v) => {
                if (isAgentBackend(v)) setCustomBackend(v);
              }}
            >
              <SelectTrigger className="h-7 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_BACKENDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {BACKEND_LABEL[b]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              placeholder="model-id"
              spellCheck={false}
              className="h-7 w-56 font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!customDraft.trim()}
              onClick={() => {
                const id = customDraft.trim();
                if (!id) return;
                const current = getCustomModels();
                setCustomModels({
                  ...current,
                  [customBackend]: [...(current[customBackend] ?? []), id],
                });
                setCustomDraft("");
              }}
            >
              Add
            </Button>
          </div>
          {Object.entries(getCustomModels()).some(([, ids]) => ids.length > 0) && (
            <div className="flex flex-wrap gap-1.5 pt-2">
              {Object.entries(getCustomModels()).flatMap(([b, ids]) => {
                if (!isAgentBackend(b)) return [];
                return (ids ?? []).map((id) => (
                  <span
                    key={`${b}:${id}`}
                    className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs"
                  >
                    <span className="text-muted-foreground">{BACKEND_LABEL[b]}</span>
                    {id}
                    <button
                      type="button"
                      aria-label={`Remove ${id}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        const current = getCustomModels();
                        const kept = (current[b] ?? []).filter((v) => v !== id);
                        setCustomModels({ ...current, [b]: kept });
                      }}
                    >
                      ×
                    </button>
                  </span>
                ));
              })}
            </div>
          )}
        </Row>
      </Group>

      <Group
        title="Launch"
        hint="Per-backend binary and extra arguments for chat agents. Arguments run after the built-in flags, so a repeated flag wins. Empty means the CLI on PATH."
      >
        {AGENT_BACKENDS.map((b) => {
          const launch = settings.providerLaunch[b];
          const setLaunch = (
            patch: Partial<{
              command: string;
              args: string;
              configDir: string;
              env: { name: string; value: string }[];
            }>
          ) =>
            onUpdate({
              providerLaunch: {
                ...settings.providerLaunch,
                [b]: {
                  command: launch?.command ?? "",
                  args: launch?.args ?? "",
                  configDir: launch?.configDir ?? "",
                  env: launch?.env ?? [],
                  ...patch,
                },
              },
            });
          return (
            <div
              key={b}
              className="grid gap-3 border-b pb-5 last:border-0 last:pb-0"
            >
              <div className="flex items-center gap-2">
                <img
                  src={`/provider-icons/${b}.svg`}
                  alt=""
                  className="size-4 object-contain"
                />
                <span className="text-sm font-medium">{BACKEND_LABEL[b]}</span>
              </div>
              <Field label="Command">
                <Input
                  value={launch?.command ?? ""}
                  placeholder={b}
                  spellCheck={false}
                  className="font-mono text-sm"
                  onChange={(e) => setLaunch({ command: e.target.value })}
                />
              </Field>
              <Field
                label="Extra arguments"
                hint="Tokenized like a shell — quotes group, no shell runs."
              >
                <Input
                  value={launch?.args ?? ""}
                  placeholder="--flag value"
                  spellCheck={false}
                  className="font-mono text-sm"
                  onChange={(e) => setLaunch({ args: e.target.value })}
                />
              </Field>
              {b === "claude" && (
                <Field
                  label="Config directory"
                  hint="CLAUDE_CONFIG_DIR. Empty uses ~/.claude — set this for a second account or a router."
                >
                  <Input
                    value={launch?.configDir ?? ""}
                    placeholder="~/.claude_work"
                    spellCheck={false}
                    className="font-mono text-sm"
                    onChange={(e) =>
                      setLaunch({ configDir: e.target.value })
                    }
                  />
                </Field>
              )}
              <LaunchEnvRows
                rows={launch?.env ?? []}
                onChange={(env) => setLaunch({ env })}
              />
            </div>
          );
        })}
      </Group>

      <Group
        title="Claude profiles"
        hint="Extra named Claudes — work vs personal, OpenRouter, a local router. The Launch section above is the default."
      >
        {settings.claudeProfiles.map((profile) => {
          const patch = (next: Partial<typeof profile>) =>
            onUpdate({
              claudeProfiles: settings.claudeProfiles.map((p) =>
                p.id === profile.id ? { ...p, ...next } : p
              ),
            });
          return (
            <div
              key={profile.id}
              className="grid gap-3 border-b pb-5 last:border-0 last:pb-0"
            >
              <div className="flex items-center justify-between gap-2">
                <Input
                  value={profile.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  placeholder="Personal"
                  className="h-8 max-w-56"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onUpdate({
                      claudeProfiles: settings.claudeProfiles.filter(
                        (p) => p.id !== profile.id
                      ),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <Field label="Command">
                <Input
                  value={profile.command}
                  placeholder="claude"
                  spellCheck={false}
                  className="font-mono text-sm"
                  onChange={(e) => patch({ command: e.target.value })}
                />
              </Field>
              <Field
                label="Config directory"
                hint="CLAUDE_CONFIG_DIR for this profile."
              >
                <Input
                  value={profile.configDir}
                  placeholder="~/.claude_personal"
                  spellCheck={false}
                  className="font-mono text-sm"
                  onChange={(e) =>
                    patch({ configDir: e.target.value })
                  }
                />
              </Field>
              <LaunchEnvRows
                rows={profile.env}
                onChange={(env) => patch({ env })}
              />
            </div>
          );
        })}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onUpdate({
                claudeProfiles: [
                  ...settings.claudeProfiles,
                  {
                    id: `claude-${Date.now().toString(36)}`,
                    name: "Personal",
                    command: "",
                    args: "",
                    configDir: "",
                    env: [],
                  },
                ],
              })
            }
          >
            Add Claude profile
          </Button>
        </div>
      </Group>
    </>
  );
};

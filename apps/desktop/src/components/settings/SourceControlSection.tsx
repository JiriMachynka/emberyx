import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { homeDir } from "@tauri-apps/api/path";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { Group, Row, SwitchRow, Tile } from "@/components/SettingsFields";
import { AGENT_BACKENDS, BACKEND_LABEL } from "@/lib/agentBackend";
import {
  commitDraftClosedLabel,
  commitDraftOptions,
} from "@/lib/commitDraft";
import { codexModelEntries, opencodeOwnModels } from "@/lib/modelCatalog";
import {
  useAcpModels,
  useClaudeModels,
  useCodexModels,
  useProviderStatus,
  type ForgeCliStatus,
} from "@/lib/queries";
import type { Settings } from "@/lib/settings";

/** Radix Select refuses an empty item value, so "no model" needs a name of its
 *  own on the way through the picker. */
const NO_COMMIT_MODEL = "off";

export const SourceControlSection = ({
  settings,
  onUpdate,
  forgeClis,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  forgeClis: ForgeCliStatus[];
}) => {
  const claudeModels = useClaudeModels();
  const providers = useProviderStatus().data ?? [];
  const installed = (id: string) => providers.some((p) => p.id === id && p.installed);
  // Catalogs for the other CLIs need a directory to start in. Home is not a
  // project, so OpenCode answers with its default list rather than one repo's
  // opencode.json. Claude's list doesn't need a process at all.
  const wantsCatalog = installed("codex") || installed("opencode") || installed("grok");
  const home = useQuery({
    queryKey: ["paths", "home"],
    queryFn: () => homeDir(),
    enabled: wantsCatalog,
    staleTime: Infinity,
    retry: false,
  });
  const cwd = home.data ?? "";
  const codexOn = installed("codex");
  const grokOn = installed("grok");
  const opencodeOn = installed("opencode");
  const codexCatalog = useCodexModels(cwd, !!cwd && codexOn);
  const grokCatalog = useAcpModels("grok", cwd, !!cwd && grokOn);
  const opencodeCatalog = useAcpModels("opencode", cwd, !!cwd && opencodeOn);
  const selected = settings.commitMessageModel;
  const options = useMemo(
    () =>
      commitDraftOptions({
        claude: claudeModels,
        codex: codexModelEntries(codexCatalog.data ?? []),
        grok: grokCatalog.data ?? [],
        opencode: opencodeOwnModels(opencodeCatalog.data ?? []),
        selected,
      }),
    [claudeModels, codexCatalog.data, grokCatalog.data, opencodeCatalog.data, selected]
  );
  const closed =
    selected ? commitDraftClosedLabel(selected, options) : "Off";

  return (
    <>
      <Group
        title="CLIs"
        hint="Reviews, clone, and publish use the GitHub (gh) and GitLab (glab) CLIs on your PATH. Log in with gh auth login or glab auth login — Emberyx never stores a PAT of its own."
      >
        <div className="grid gap-1.5">
          {forgeClis.map((p) => {
            const status = !p.installed
              ? "not installed"
              : p.authenticated
                ? (p.version ?? "logged in")
                : "not logged in";
            return (
              <Tile
                key={p.id}
                icon={
                  <img
                    src={`/source-control-icons/${p.id}.svg`}
                    alt=""
                    className="size-5 shrink-0 object-contain"
                  />
                }
                status={
                  p.authenticated
                    ? "on"
                    : p.installed
                      ? "warn"
                      : "off"
                }
                title={p.label}
                meta={<code className="truncate">{p.binary}</code>}
                aside={status}
              />
            );
          })}
        </div>
      </Group>

      <Group title="Git">
        <Row
          label="Remote"
          hint="Git remote used to fetch and check out review branches."
          control={
            <Input
              value={settings.gitlabRemote}
              onChange={(e) => onUpdate({ gitlabRemote: e.target.value })}
              placeholder="origin"
              spellCheck={false}
            />
          }
        />
        <SwitchRow
          label="Hide whitespace changes"
          hint="Working-tree diffs in the Changes panel skip whitespace-only edits (git -w)."
          checked={settings.diffIgnoreWhitespace}
          onChange={(v) => onUpdate({ diffIgnoreWhitespace: v })}
        />
        <Row
          label="Commit message model"
          hint="Drafts a commit message from the diff when you press Generate in the commit box. The call goes to the provider you pick, so it doesn't have to spend Claude usage. OpenCode's free models only answer inside OpenCode itself — Codex, an OpenCode Go model, or Grok will draft from here."
          control={
            <Select
              value={selected || NO_COMMIT_MODEL}
              onValueChange={(v) =>
                onUpdate({
                  commitMessageModel: v === NO_COMMIT_MODEL ? "" : v,
                })
              }
            >
              <SelectTrigger className="overflow-hidden">
                <span className="truncate">{closed}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_COMMIT_MODEL}>Off</SelectItem>
                {AGENT_BACKENDS.map((provider) => {
                  const rows = options.filter((o) => o.provider === provider);
                  // Claude's list is local. The others come from a CLI, so an
                  // installed provider with no rows yet is still loading — an
                  // empty group would look like that provider isn't offered.
                  const catalog =
                    provider === "codex"
                      ? codexCatalog
                      : provider === "grok"
                        ? grokCatalog
                        : provider === "opencode"
                          ? opencodeCatalog
                          : undefined;
                  const offered = provider === "claude" || installed(provider);
                  if (!offered) return null;
                  const failed = !!catalog && (home.isError || catalog.isError);
                  const waiting = !!catalog && !catalog.data && !failed;
                  if (rows.length === 0 && !waiting && !failed) return null;
                  return (
                    <SelectGroup key={provider}>
                      <SelectLabel>{BACKEND_LABEL[provider]}</SelectLabel>
                      {rows.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                      {waiting && (
                        <SelectItem value={`loading-${provider}`} disabled>
                          Loading…
                        </SelectItem>
                      )}
                      {failed && (
                        <SelectItem value={`unavailable-${provider}`} disabled>
                          Couldn't load models
                        </SelectItem>
                      )}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
          }
        />
      </Group>
    </>
  );
};

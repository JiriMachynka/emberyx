import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CLAUDE_MODELS } from "@/lib/modelCatalog";
import { Group, Row, SwitchRow, Tile } from "@/components/SettingsFields";
import type { ForgeCliStatus } from "@/lib/queries";
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
}) => (
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
        hint="Drafts a commit message from the diff when you press Generate in the commit box. One throwaway claude -p call, so the list is Claude's."
        control={
          <Select
            value={settings.commitMessageModel || NO_COMMIT_MODEL}
            onValueChange={(v) =>
              onUpdate({
                commitMessageModel: v === NO_COMMIT_MODEL ? "" : v,
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_COMMIT_MODEL}>Off</SelectItem>
              {CLAUDE_MODELS.filter((m) => !m.legacy).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </Group>
  </>
);

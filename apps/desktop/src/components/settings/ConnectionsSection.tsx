import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IDES, IDE_LABEL, type IdeId } from "@/lib/ide";
import { Group, Row, SwitchRow, Tile } from "@/components/SettingsFields";
import type { DaemonHealth } from "@/lib/queries";
import type { Settings } from "@/lib/settings";

export const ConnectionsSection = ({
  settings,
  onUpdate,
  daemon,
  startingDaemon,
  onStartDaemon,
  diagnosticsCopied,
  copyDiagnostics,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
  daemon: DaemonHealth | null;
  startingDaemon: boolean;
  onStartDaemon: () => Promise<void>;
  diagnosticsCopied: boolean;
  copyDiagnostics: () => Promise<void>;
}) => (
  <>
    <Group title="Persistent agents">
      <Tile
        status={daemon ? "on" : "off"}
        title={daemon ? "Running" : "Not running"}
        meta={
          daemon
            ? `v${daemon.version} · ${daemon.liveCount} live of ${daemon.agentCount} agent${
                daemon.agentCount === 1 ? "" : "s"
              }${daemon.outdated ? " · older than this app" : ""}`
            : "emberyxd isn't answering on its socket."
        }
        aside={
          !daemon && (
            <Button
              variant="outline"
              size="sm"
              onClick={onStartDaemon}
              disabled={startingDaemon}
            >
              {startingDaemon ? "Starting…" : "Start"}
            </Button>
          )
        }
      />
      <SwitchRow
        label="Keep agents running in the background"
        hint="Agents, terminals and dev servers keep running after you quit Emberyx."
        checked={settings.persistentAgents}
        onChange={(v) => onUpdate({ persistentAgents: v })}
      />
    </Group>

    <Group title="External editor">
      <Row
        label="Open in"
        control={
          <Select
            value={settings.ide}
            onValueChange={(v) => onUpdate({ ide: v as IdeId })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IDES.map((ide) => (
                <SelectItem key={ide.id} value={ide.id}>
                  {ide.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">
                {IDE_LABEL.custom}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {settings.ide === "custom" && (
        <Row
          wide
          label="Custom command"
          hint="Placeholders: {project} {file} {line} {column}. Run directly, not through a shell — quote paths with spaces."
          control={
            <Input
              value={settings.ideCustomCommand}
              onChange={(e) =>
                onUpdate({ ideCustomCommand: e.target.value })
              }
              placeholder={'mate "{project}" -l {line} "{file}"'}
              spellCheck={false}
            />
          }
        />
      )}
    </Group>

    <Group title="Diagnostics">
      <Row
        label="Copy diagnostics"
        control={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyDiagnostics()}
          >
            {diagnosticsCopied ? "Copied" : "Copy"}
          </Button>
        }
      />
    </Group>
  </>
);

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Group, Row, SwitchRow } from "@/components/SettingsFields";
import { NumberStepper } from "./NumberStepper";
import { T3ImportRow } from "./T3ImportRow";
import type { Settings } from "@/lib/settings";

export const GeneralSection = ({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}) => (
  <Group>
    <Row
      label="Thread list"
      hint="Whether the sidebar groups threads by project or shows one list across every open project."
      control={
        <Select
          value={settings.threadView}
          onValueChange={(value) => {
            if (value === "project" || value === "all") {
              onUpdate({ threadView: value });
            }
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">By project</SelectItem>
            <SelectItem value="all">All threads</SelectItem>
          </SelectContent>
        </Select>
      }
    />

    {settings.threadView === "all" && (
      <>
        <Row
          label="Group threads"
          hint="Put one heading per repository above the active threads, with worktrees folded into their parent repo."
          control={
            <Select
              value={settings.threadGrouping}
              onValueChange={(value) => {
                if (value === "none" || value === "repository") {
                  onUpdate({ threadGrouping: value });
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">One flat list</SelectItem>
                <SelectItem value="repository">
                  By repository
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />

        <Row
          label="Days of inactivity before a thread settles"
          hint="Days a thread can go untouched before it folds into Settled. Set 0 to keep every thread listed until you settle it yourself."
          control={
            <NumberStepper
              value={settings.threadSettleDays}
              min={0}
              max={90}
              onChange={(n) => onUpdate({ threadSettleDays: n })}
            />
          }
        />

        <SwitchRow
          label="Settle merged branches"
          hint="Fold a thread away once its branch has been merged into the default branch, however recent the thread is."
          checked={settings.threadAutoSettleOnMerge}
          onChange={(v) => onUpdate({ threadAutoSettleOnMerge: v })}
        />
      </>
    )}

    <SwitchRow
      label="Expand every project"
      hint="Keep each project's own sessions listed in the sidebar, not just the active project's."
      checked={settings.expandAllProjects}
      onChange={(v) => onUpdate({ expandAllProjects: v })}
    />

    <SwitchRow
      label="Auto-open dev panel on run"
      hint="Reveal the dev output panel whenever a dev, build, or start run begins."
      checked={settings.autoOpenDevPanel}
      onChange={(v) => onUpdate({ autoOpenDevPanel: v })}
    />
    <T3ImportRow />
  </Group>
);

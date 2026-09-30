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
      label="Group threads"
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
      hint="0 keeps every thread listed."
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
      checked={settings.threadAutoSettleOnMerge}
      onChange={(v) => onUpdate({ threadAutoSettleOnMerge: v })}
    />

    <T3ImportRow />
  </Group>
);

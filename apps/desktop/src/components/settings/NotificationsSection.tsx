import { Group, SwitchRow } from "@/components/SettingsFields";
import type { Settings } from "@/lib/settings";

export const NotificationsSection = ({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}) => (
  <Group>
    <SwitchRow
      label="Task finished"
      checked={settings.notifyOnDone}
      onChange={(v) => onUpdate({ notifyOnDone: v })}
    />
    <SwitchRow
      label="Errors"
      checked={settings.notifyOnError}
      onChange={(v) => onUpdate({ notifyOnError: v })}
    />
    <SwitchRow
      label="Account issues"
      checked={settings.notifyOnAccountIssue}
      onChange={(v) => onUpdate({ notifyOnAccountIssue: v })}
    />
    <SwitchRow
      label="Only when unfocused"
      checked={settings.notifyOnlyWhenUnfocused}
      onChange={(v) => onUpdate({ notifyOnlyWhenUnfocused: v })}
    />
    <SwitchRow
      label="Play sound"
      checked={settings.notifySound}
      onChange={(v) => onUpdate({ notifySound: v })}
    />
  </Group>
);

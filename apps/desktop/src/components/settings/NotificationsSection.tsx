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
      label="Notify when a task finishes"
      hint="Raise a notification once a run completes."
      checked={settings.notifyOnDone}
      onChange={(v) => onUpdate({ notifyOnDone: v })}
    />
    <SwitchRow
      label="Notify on errors"
      hint="Raise a notification when a run fails."
      checked={settings.notifyOnError}
      onChange={(v) => onUpdate({ notifyOnError: v })}
    />
    <SwitchRow
      label="Notify on account issues"
      hint="Raise a notification when the usage limit is hit or the login expires."
      checked={settings.notifyOnAccountIssue}
      onChange={(v) => onUpdate({ notifyOnAccountIssue: v })}
    />
    <SwitchRow
      label="Only when the app is unfocused"
      hint="Stay quiet while Emberyx is the focused window."
      checked={settings.notifyOnlyWhenUnfocused}
      onChange={(v) => onUpdate({ notifyOnlyWhenUnfocused: v })}
    />
    <SwitchRow
      label="Play sound"
      hint="Play a chime alongside each notification."
      checked={settings.notifySound}
      onChange={(v) => onUpdate({ notifySound: v })}
    />
  </Group>
);

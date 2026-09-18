import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Group, Row, SwitchRow } from "@/components/SettingsFields";
import type { Settings } from "@/lib/settings";

export const JevSection = ({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}) => (
  <Group>
    <KeyRow />
    <SwitchRow
      label="Jev judgments"
      hint="Auto-approve low-risk OpenCode and Grok tool calls, suggest a skill, flag risky diffs, screen preview pages, and bump a small model on hard tasks. A saved key is not enough — this has to be on too."
      checked={settings.jevAutoApprove}
      onChange={(v) => onUpdate({ jevAutoApprove: v })}
    />
  </Group>
);

const KeyRow = () => {
  const [present, setPresent] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invoke<boolean>("typesafe_key_present").then((v) =>
      setPresent(Boolean(v))
    );
  }, []);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    try {
      await invoke("typesafe_key_set", { key });
      setDraft("");
      setPresent(true);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      await invoke("typesafe_key_clear");
      setDraft("");
      setPresent(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      label="API key"
      hint="From console.typesafe.ai. Stored with the app's other data, not in settings. Sent only to TypeSafe."
      wide
      control={
        <div className="flex h-9 w-full items-stretch justify-end gap-1.5">
          <Input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={present ? "Key saved" : undefined}
            spellCheck={false}
            autoComplete="off"
            className="h-9 font-mono text-sm"
          />
          <Button
            variant="outline"
            disabled={busy || !draft.trim()}
            onClick={() => void save()}
            className="h-9"
          >
            Save
          </Button>
          {present && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void clear()}
              className="h-9"
            >
              Clear
            </Button>
          )}
        </div>
      }
    />
  );
};

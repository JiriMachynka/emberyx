import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Group, Row, SwitchRow } from "@/components/SettingsFields";
import { THEMES } from "@/lib/themes";
import { ThemeCard } from "./ThemeCard";
import { FontSelect, INTERFACE_FONT_OPTIONS } from "./FontSelect";
import { NumberStepper } from "./NumberStepper";
import type { Settings } from "@/lib/settings";

export const AppearanceSection = ({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}) => (
  <>
    <Group
      title="Theme"
      hint="Every theme is dark — Emberyx is terminal-first and has no light mode. A theme sets the surfaces and the single accent; type, spacing and borders never change."
    >
      <div className="grid grid-cols-2 gap-2.5">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            selected={settings.theme === t.id}
            onSelect={() => onUpdate({ theme: t.id })}
          />
        ))}
      </div>
    </Group>

    <Group title="Layout">
      <Row
        label="Workspace"
        hint="Column keeps a project rail and a workspace column with Sessions, Explorer, and Changes."
        control={
          <Select
            value={settings.workspaceLayout}
            onValueChange={(value) => {
              if (value === "classic" || value === "column") {
                onUpdate({ workspaceLayout: value });
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="classic">Classic</SelectItem>
              <SelectItem value="column">Column</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <SwitchRow
        label="Right sidebar"
        hint="Terminal, Preview, Review, and merge requests. Off hides the dock until you turn it back on."
        checked={settings.rightDock}
        onChange={(v) => onUpdate({ rightDock: v })}
      />
    </Group>

    <Group title="Interface">
      <Row
        label="Chat font"
        hint="Used by the chat transcript, the composer and the thread list."
        control={
          <FontSelect
            value={settings.chatFontFamily}
            options={INTERFACE_FONT_OPTIONS}
            onChange={(v) => onUpdate({ chatFontFamily: v })}
          />
        }
      />
      <Row
        label="Terminal font"
        hint="Used by the terminal, dev output and log panes."
        control={
          <FontSelect
            value={settings.fontFamily}
            onChange={(v) => onUpdate({ fontFamily: v })}
          />
        }
      />
      <Row
        label="Font size"
        hint="Terminal and chat text size, in pixels."
        control={
          <NumberStepper
            value={settings.fontSize}
            min={8}
            max={32}
            onChange={(n) => onUpdate({ fontSize: n })}
          />
        }
      />
      <Row
        label="Scrollback"
        hint="Lines of terminal history kept per session."
        control={
          <NumberStepper
            value={settings.scrollback}
            min={100}
            max={100000}
            step={100}
            onChange={(n) => onUpdate({ scrollback: n })}
          />
        }
      />
    </Group>

    <Group title="Editor">
      <Row
        label="Font family"
        hint="Used by the built-in editor, chat code blocks and diffs."
        control={
          <FontSelect
            value={settings.editorFontFamily}
            onChange={(v) => onUpdate({ editorFontFamily: v })}
          />
        }
      />
      <Row
        label="Font size"
        hint="Editor text size in pixels."
        control={
          <NumberStepper
            value={settings.editorFontSize}
            min={8}
            max={32}
            onChange={(n) => onUpdate({ editorFontSize: n })}
          />
        }
      />
      <SwitchRow
        label="Wrap long lines"
        hint="The editor wraps instead of scrolling sideways."
        checked={settings.wordWrap}
        onChange={(v) => onUpdate({ wordWrap: v })}
      />
    </Group>
  </>
);

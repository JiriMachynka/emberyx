import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Group, Row, SwitchRow } from "@/components/SettingsFields";
import {
  WALLPAPER_EXTENSIONS,
  clearWallpaper,
  importWallpaper,
} from "@/lib/wallpaper";
import { THEMES } from "@/lib/themes";
import { ThemeCard } from "./ThemeCard";
import { FontSelect, INTERFACE_FONT_OPTIONS } from "./FontSelect";
import { NumberStepper } from "./NumberStepper";
import {
  WINDOW_OPACITY_OPTIONS,
  clampWindowOpacity,
} from "@/lib/windowOpacity";
import type { Settings } from "@/lib/settings";

export const AppearanceSection = ({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => void;
}) => (
  <>
    <Group title="Theme">
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

    <Group title="Window">
      <Row
        label="Opacity"
        hint="100% is solid. Lower values let the desktop show through the chrome."
        control={
          <Select
            value={String(settings.windowOpacity)}
            onValueChange={(value) =>
              onUpdate({ windowOpacity: clampWindowOpacity(Number(value)) })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_OPACITY_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n === 100 ? "100% (solid)" : `${n}%`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <Row
        label="Background"
        hint="An image behind the window. Lower the opacity to let it show."
        control={
          <div className="flex items-center gap-2">
            {settings.windowBackground && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onUpdate({ windowBackground: "" });
                  void clearWallpaper();
                }}
              >
                Remove
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const picked = await pickFile({
                  multiple: false,
                  filters: [{ name: "Image", extensions: WALLPAPER_EXTENSIONS }],
                });
                if (picked) {
                  onUpdate({ windowBackground: await importWallpaper(picked) });
                }
              }}
            >
              {settings.windowBackground ? "Replace…" : "Choose image…"}
            </Button>
          </div>
        }
      />
    </Group>

    <Group title="Layout">
      <Row
        label="Workspace"
        hint="Column adds a Sessions / Explorer / Changes column beside the project rail."
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
        checked={settings.rightDock}
        onChange={(v) => onUpdate({ rightDock: v })}
      />
    </Group>

    <Group title="Interface">
      <Row
        label="Chat font"
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
        control={
          <FontSelect
            value={settings.fontFamily}
            onChange={(v) => onUpdate({ fontFamily: v })}
          />
        }
      />
      <Row
        label="Font size"
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
        control={
          <FontSelect
            value={settings.editorFontFamily}
            onChange={(v) => onUpdate({ editorFontFamily: v })}
          />
        }
      />
      <Row
        label="Font size"
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
        checked={settings.wordWrap}
        onChange={(v) => onUpdate({ wordWrap: v })}
      />
    </Group>
  </>
);

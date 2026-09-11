import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Group } from "@/components/SettingsFields";
import { COMMANDS, type CommandId } from "@/lib/commands";
import {
  chordFromEvent,
  conflictingBindings,
  displayChord,
  formatChord,
  resetAllBindings,
  resetBinding,
  resolveBindings,
  setBinding,
} from "@/lib/keybindings";

/** Chords no single binding can describe: the composer's own keys, and tab
 *  selection, which is nine chords feeding one action an argument. Listed for
 *  reference rather than offered for rebinding. */
const COMPOSER_KEYS: { action: string; keys: string }[] = [
  { action: "Send message", keys: "↵" },
  { action: "Newline in composer", keys: "⇧↵" },
  { action: "Select tab by number", keys: "⌘1…9" },
];

/** Rebindable commands, plus the fixed ones, plus the composer's own keys.
 *  Recording a chord replaces the binding on the next keypress; Esc backs out. */
export function ShortcutsSection() {
  const [bindings, setBindings] = useState(resolveBindings);
  const [recording, setRecording] = useState<CommandId | null>(null);
  const clashing = conflictingBindings(bindings);

  const publish = (next: Record<CommandId, string>) => {
    setBindings(next);
    // Tell the live handler to re-read; a rebind that needs a restart to work
    // reads as broken.
    window.dispatchEvent(new Event("emberyx:keybindings"));
  };

  useEffect(() => {
    if (!recording) return;
    const target = recording;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(e);
      // A bare modifier isn't a binding yet — keep listening for the real key.
      if (!chord || !(chord.mod || chord.alt)) return;
      publish(setBinding(target, formatChord(chord)));
      setRecording(null);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  return (
    <>
      <Group title="Commands">
        <div className="grid gap-1">
          {COMMANDS.map((command) => (
            <div
              key={command.id}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm odd:bg-secondary/30"
            >
              <span className="min-w-0 truncate text-muted-foreground">
                {command.label}
                {clashing.has(command.id) && (
                  <span className="ml-2 text-xs text-destructive">
                    same keys as another command
                  </span>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {command.rebindable ? (
                  <button
                    type="button"
                    onClick={() => setRecording(command.id)}
                    className="rounded border bg-background px-1.5 py-0.5 text-xs transition-colors hover:bg-accent"
                  >
                    {recording === command.id
                      ? "Press keys…"
                      : displayChord(bindings[command.id])}
                  </button>
                ) : (
                  <kbd
                    title="Owned by the app menu, which sees the keys first"
                    className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {displayChord(bindings[command.id])}
                  </kbd>
                )}
                {command.rebindable &&
                  bindings[command.id] !== command.defaultKey && (
                    <button
                      type="button"
                      onClick={() => publish(resetBinding(command.id))}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Reset
                    </button>
                  )}
              </div>
            </div>
          ))}
        </div>
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => publish(resetAllBindings())}
          >
            Reset all shortcuts
          </Button>
        </div>
      </Group>

      <Group title="Composer">
        <div className="grid gap-1">
          {COMPOSER_KEYS.map((s) => (
            <div
              key={s.keys}
              className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm odd:bg-secondary/30"
            >
              <span className="text-muted-foreground">{s.action}</span>
              <kbd className="rounded border bg-background px-1.5 py-0.5 text-xs">
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </Group>
    </>
  );
}

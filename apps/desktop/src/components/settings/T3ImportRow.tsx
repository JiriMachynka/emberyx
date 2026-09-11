import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Row } from "@/components/SettingsFields";

/** Summary of one T3 Code import pass, as the Rust side reports it. */
interface T3ImportSummary {
  threadsImported: number;
  threadsSkipped: number;
  threadsUnmatched: number;
  messages: number;
  toolCalls: number;
  eventsWritten: number;
  projects: string[];
}

/** Bring T3 Code's conversation history into the local event log. Hidden
 *  outright when there is no T3 store on this machine — an action that can only
 *  fail is worse than an absent one. Imported threads are history: they render
 *  in the sidebar, but no CLI can continue them, which the pane says on open. */
export function T3ImportRow() {
  const [available, setAvailable] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<T3ImportSummary | null>(null);

  useEffect(() => {
    void invoke<boolean>("t3_import_available")
      .then(setAvailable)
      .catch(() => setAvailable(false));
  }, []);

  if (!available) return null;

  const run = async () => {
    setRunning(true);
    try {
      const summary = await invoke<T3ImportSummary>("t3_import_run", {
        source: null,
      });
      setResult(summary);
      toast.success(
        summary.threadsImported > 0
          ? `Imported ${summary.threadsImported} threads from T3 Code`
          : "Nothing new to import"
      );
    } catch (e) {
      toast.error("Import failed", { description: String(e) });
    } finally {
      setRunning(false);
    }
  };

  const hint = result
    ? `${result.threadsImported} threads, ${result.messages} messages and ${result.toolCalls} tool calls across ${result.projects.length} projects. ${result.threadsSkipped} already here${result.threadsUnmatched > 0 ? `, ${result.threadsUnmatched} skipped for a missing project folder` : ""}.`
    : "Copies T3 Code's threads into Emberyx's own store. Read-only history — the agent behind an imported thread starts fresh. Safe to run twice.";

  return (
    <Row
      label="Import from T3 Code"
      hint={hint}
      control={
        <Button variant="outline" disabled={running} onClick={() => void run()}>
          {running ? "Importing…" : "Import"}
        </Button>
      }
    />
  );
}

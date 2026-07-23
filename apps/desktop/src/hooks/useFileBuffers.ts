import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fileKeys, useFileText, useInvalidateGit } from "@/lib/queries";

/**
 * The editor's open file and its unsaved edits. Buffers are keyed by path and
 * only hold text that differs from disk, so `Object.keys(buffers)` is exactly
 * the set of dirty files and switching files never loses work.
 */
export function useFileBuffers(projectPath: string) {
  const [selected, setSelected] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Bumped on every successful write, so caches keyed to file contents (the
  // hover hook's definition lookups) know to drop what they hold.
  const [savedAt, setSavedAt] = useState(0);
  const qc = useQueryClient();
  const invalidateGit = useInvalidateGit();

  const query = useFileText(selected);
  const saved = query.data ?? "";
  const text = selected != null && selected in buffers ? buffers[selected] : saved;
  const dirty = selected != null && selected in buffers;
  const dirtyPaths = useMemo(() => new Set(Object.keys(buffers)), [buffers]);

  function edit(next: string) {
    if (!selected) return;
    setBuffers((b) => {
      if (next === saved) {
        const copy = { ...b };
        delete copy[selected];
        return copy;
      }
      return { ...b, [selected]: next };
    });
  }

  async function save() {
    if (!selected || !dirty || saving) return;
    const contents = text;
    setSaving(true);
    try {
      await invoke("write_text_file", { path: selected, contents });
      qc.setQueryData(fileKeys.text(selected), contents);
      setBuffers((b) => {
        const next = { ...b };
        delete next[selected];
        return next;
      });
      invalidateGit(projectPath);
      setSavedAt((n) => n + 1);
    } catch (e) {
      toast.error(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  return {
    selected,
    select: setSelected,
    text,
    dirty,
    dirtyPaths,
    saving,
    savedAt,
    save,
    edit,
    /** Load state of the selected file, for the pane's empty/error/loading UI. */
    status: {
      isPending: query.isPending,
      isError: query.isError,
      error: query.error,
    },
  };
}

import { useCallback, useState } from "react";
import type { Project } from "@/types";
import {
  deriveDefaultActions,
  getStoredActions,
  setStoredActions,
  type ProjectAction,
} from "@/lib/actions";

/** CRUD over a project's actions. The effective list is the saved actions, or
 *  detection-derived defaults until the user first edits (which materialises
 *  them). */
export function useProjectActions(project: Project | null) {
  const path = project?.path ?? "";
  const workspace = project?.workspace ?? null;
  const [, force] = useState(0);

  const actions = path
    ? getStoredActions(path) ?? deriveDefaultActions(workspace)
    : [];

  const commit = useCallback(
    (mutate: (base: ProjectAction[]) => ProjectAction[]) => {
      if (!path) return;
      const base = getStoredActions(path) ?? deriveDefaultActions(workspace);
      setStoredActions(path, mutate(base));
      force((n) => n + 1);
    },
    [path, workspace]
  );

  const upsertAction = useCallback(
    (action: ProjectAction) =>
      commit((base) => {
        const idx = base.findIndex((a) => a.id === action.id);
        return idx >= 0
          ? base.map((a) => (a.id === action.id ? action : a))
          : [...base, action];
      }),
    [commit]
  );

  const removeAction = useCallback(
    (id: string) => commit((base) => base.filter((a) => a.id !== id)),
    [commit]
  );

  return { actions, upsertAction, removeAction };
}

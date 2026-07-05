import { useRef, useState } from "react";
import type { Session } from "@/types";

/**
 * Owns every terminal session across all open projects (agent + dev tabs),
 * plus which session is active within each project. Session ids stay globally
 * unique so the agent-status map can key on them directly.
 */
export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeByProject, setActiveByProject] = useState<Record<string, string>>(
    {}
  );
  const counter = useRef(0);
  const nextId = () => `s${++counter.current}`;

  function setActive(projectId: string, id: string) {
    setActiveByProject((m) => ({ ...m, [projectId]: id }));
  }

  /** Start an agent session for a project and focus it. Returns its id. */
  function startAgent(
    projectId: string,
    cwd: string,
    command: string,
    label = "agent"
  ): string {
    const id = nextId();
    setSessions((s) => [
      ...s,
      { id, projectId, label, cwd, command, kind: "agent" },
    ]);
    setActive(projectId, id);
    return id;
  }

  /** Add a background dev-server session (does not steal focus). */
  function addDev(
    projectId: string,
    label: string,
    cwd: string,
    command: string
  ) {
    const id = nextId();
    setSessions((s) => [
      ...s,
      { id, projectId, label, cwd, command, kind: "dev" },
    ]);
  }

  function closeSession(id: string) {
    setSessions((prev) => {
      const target = prev.find((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      if (target) {
        setActiveByProject((m) => {
          if (m[target.projectId] !== id) return m;
          const siblings = next.filter((s) => s.projectId === target.projectId);
          const fallback =
            siblings.find((s) => s.kind === "agent")?.id ??
            siblings[siblings.length - 1]?.id;
          const copy = { ...m };
          if (fallback) copy[target.projectId] = fallback;
          else delete copy[target.projectId];
          return copy;
        });
      }
      return next;
    });
  }

  /** Reorder a session within its project, dropping it at another tab's slot. */
  function moveSession(projectId: string, draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    setSessions((prev) => {
      const ids = prev
        .filter((s) => s.projectId === projectId)
        .map((s) => s.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return prev;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      const byId = new Map(prev.map((s) => [s.id, s]));
      let i = 0;
      return prev.map((s) =>
        s.projectId === projectId ? (byId.get(ids[i++]) as Session) : s
      );
    });
  }

  function stopAllDev(projectId: string) {
    setSessions((prev) => {
      const agent = prev.find(
        (s) => s.projectId === projectId && s.kind === "agent"
      );
      if (agent) setActive(projectId, agent.id);
      return prev.filter(
        (s) => !(s.projectId === projectId && s.kind === "dev")
      );
    });
  }

  /** Remove every session belonging to a closed project. */
  function closeProjectSessions(projectId: string) {
    setSessions((prev) => prev.filter((s) => s.projectId !== projectId));
    setActiveByProject((m) => {
      const copy = { ...m };
      delete copy[projectId];
      return copy;
    });
  }

  const sessionsFor = (projectId: string) =>
    sessions.filter((s) => s.projectId === projectId);

  return {
    sessions,
    activeByProject,
    setActive,
    startAgent,
    addDev,
    closeSession,
    moveSession,
    stopAllDev,
    closeProjectSessions,
    sessionsFor,
  };
}

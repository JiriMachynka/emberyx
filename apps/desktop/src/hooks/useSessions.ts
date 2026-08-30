import { useRef, useState } from "react";
import type { AgentBackend } from "@/lib/agentBackend";
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

  // The list is mirrored in a ref and every mutation goes through `commit`.
  // Two mutations in the same tick are routine — a monorepo's dev servers all
  // exit together, each calling `closeSession` — and reading `sessions` from
  // the render snapshot means the second overwrites the first, resurrecting a
  // dead tab with no PTY behind it. The ref advances synchronously, so the
  // second mutation sees the first.
  const sessionsRef = useRef<Session[]>([]);
  const commit = (update: (prev: Session[]) => Session[]): Session[] => {
    const next = update(sessionsRef.current);
    sessionsRef.current = next;
    setSessions(next);
    return next;
  };

  function setActive(projectId: string, id: string) {
    setActiveByProject((m) => ({ ...m, [projectId]: id }));
  }

  /** Start a headless chat-mode agent session for a project and focus it. */
  function startChat(
    projectId: string,
    cwd: string,
    resume?: string,
    label = "chat",
    backend: AgentBackend = "claude",
    imported = false
  ): string {
    const id = nextId();
    commit((s) => [
      ...s,
      { id, projectId, label, cwd, kind: "chat", backend, resume, imported },
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
  ): string {
    const id = nextId();
    commit((s) => [
      ...s,
      { id, projectId, label, cwd, command, kind: "dev" },
    ]);
    return id;
  }

  /** Record which thread a live session ended up on, so resuming that thread
   *  returns to this pane instead of opening a second one for the same
   *  conversation. Not `resume`: that is a spawn argument, and changing it
   *  under a mounted pane respawns the agent mid-turn. */
  function setSessionThread(id: string, threadId: string) {
    commit((s) => s.map((x) => (x.id === id ? { ...x, threadId } : x)));
  }

  /** Rename a session's sidebar label (e.g. after a chat is auto-titled). */
  function renameSession(id: string, label: string) {
    commit((s) => s.map((x) => (x.id === id ? { ...x, label } : x)));
  }

  /** Repoint any project focused on a now-gone session. A shared chat can be
   *  focused by projects that don't own it, so every pointer is checked. */
  function repointActive(next: Session[], gone: Set<string>) {
    setActiveByProject((m) => {
      const copy = { ...m };
      let changed = false;
      for (const [projectId, id] of Object.entries(m)) {
        if (!gone.has(id)) continue;
        changed = true;
        const siblings = next.filter((s) => s.projectId === projectId);
        const fallback =
          siblings.find((s) => s.kind === "chat")?.id ??
          siblings[siblings.length - 1]?.id;
        if (fallback) copy[projectId] = fallback;
        else delete copy[projectId];
      }
      return changed ? copy : m;
    });
  }

  function closeSession(id: string) {
    const next = commit((prev) => prev.filter((s) => s.id !== id));
    repointActive(next, new Set([id]));
  }

  /** Reorder a session within its project, dropping it at another tab's slot. */
  function moveSession(projectId: string, draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    commit((prev) => {
      const ids = prev
        .filter((s) => s.projectId === projectId)
        .map((s) => s.id);
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return prev;
      // Drop the dragged tab into the target's slot. After removing it, a
      // rightward move shifts the target left by one, so adjust the insert.
      const [moved] = ids.splice(from, 1);
      ids.splice(from < to ? to - 1 : to, 0, moved);
      const byId = new Map(prev.map((s) => [s.id, s]));
      let i = 0;
      // The cast this replaces hid the invariant: a duplicate id collapses in
      // the Map but not in the array, so the counters diverge and `undefined`
      // lands in the session list. Keeping the original entry is the safe miss.
      return prev.map((s) => {
        if (s.projectId !== projectId) return s;
        return byId.get(ids[i++]) ?? s;
      });
    });
  }

  function stopAllDev(projectId: string) {
    const agent = sessionsRef.current.find(
      (s) => s.projectId === projectId && s.kind === "chat"
    );
    if (agent) setActive(projectId, agent.id);
    commit((prev) =>
      prev.filter((s) => !(s.projectId === projectId && s.kind === "dev"))
    );
  }

  /** Remove every session belonging to a closed project. */
  function closeProjectSessions(projectId: string) {
    const gone = new Set(
      sessionsRef.current
        .filter((s) => s.projectId === projectId)
        .map((s) => s.id)
    );
    const next = commit((prev) => prev.filter((s) => s.projectId !== projectId));
    repointActive(next, gone);
    setActiveByProject((m) => {
      const copy = { ...m };
      delete copy[projectId];
      return copy;
    });
  }

  /** A project's own sessions — the only ones it displays or may act on. */
  const sessionsFor = (projectId: string) =>
    sessions.filter((s) => s.projectId === projectId);

  return {
    sessions,
    activeByProject,
    setActive,
    startChat,
    renameSession,
    setSessionThread,
    addDev,
    closeSession,
    moveSession,
    stopAllDev,
    closeProjectSessions,
    sessionsFor,
  };
}

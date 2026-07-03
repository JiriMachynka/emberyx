import { useRef, useState } from "react";
import type { Session } from "@/types";

/** Owns the terminal session list (agent + dev tabs) and the active tab. */
export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const counter = useRef(0);
  const nextId = () => `s${++counter.current}`;

  /** Reset to a single agent session for a freshly opened project. */
  function startAgent(cwd: string, command: string): string {
    const id = nextId();
    setSessions([{ id, label: "agent", cwd, command, kind: "agent" }]);
    setActiveId(id);
    return id;
  }

  /** Add a background dev-server session (does not steal focus). */
  function addDev(label: string, cwd: string, command: string) {
    const id = nextId();
    setSessions((s) => [...s, { id, label, cwd, command, kind: "dev" }]);
  }

  function closeSession(id: string) {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setActiveId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
      return next;
    });
  }

  function stopAllDev() {
    setSessions((prev) => {
      const next = prev.filter((s) => s.kind !== "dev");
      setActiveId(next.find((s) => s.kind === "agent")?.id ?? null);
      return next;
    });
  }

  return {
    sessions,
    activeId,
    setActiveId,
    startAgent,
    addDev,
    closeSession,
    stopAllDev,
  };
}

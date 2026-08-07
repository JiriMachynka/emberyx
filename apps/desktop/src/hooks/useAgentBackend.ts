import { useState } from "react";
import { capabilitiesOf, type AgentBackend } from "@/lib/agentBackend";
import { getProjectConfigs, setProjectBackend } from "@/lib/projectConfig";
import type { Project } from "@/types";

/**
 * The active project's agent backend and what it can do. Projects may pin a
 * backend; unpinned ones follow the global default, so switching the default
 * moves every project that never chose one.
 */
export function useAgentBackend(
  activeProject: Project | null,
  fallback: AgentBackend
) {
  const [configs, setConfigs] = useState(getProjectConfigs);

  const pinned = activeProject ? configs[activeProject.path]?.backend : undefined;
  const backend = pinned ?? fallback;

  const setBackend = (next: AgentBackend | null) => {
    if (!activeProject) return;
    setConfigs(setProjectBackend(activeProject.path, next));
  };

  return { backend, pinned, capabilities: capabilitiesOf(backend), setBackend };
}

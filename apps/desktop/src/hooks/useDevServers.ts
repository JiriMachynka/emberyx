import { useState } from "react";
import { getProjectConfigs, setProjectDevCommand } from "@/lib/projectConfig";
import type { PackageInfo, Project } from "@/types";

/**
 * Starting dev servers for the active project: the workspace's detected
 * packages, its root "all" script, or a per-project custom command that
 * overrides detection and persists across restarts.
 */
export function useDevServers(
  activeProject: Project | null,
  addDev: (projectId: string, label: string, cwd: string, command: string) => void
) {
  const [configs, setConfigs] = useState(getProjectConfigs);

  const customCommand = activeProject
    ? configs[activeProject.path]?.devCommand ?? ""
    : "";

  function setCustomCommand(command: string) {
    if (!activeProject) return;
    setConfigs(setProjectDevCommand(activeProject.path, command));
  }

  function runCustom() {
    if (!activeProject || !customCommand) return;
    addDev(activeProject.id, "dev", activeProject.path, customCommand);
  }

  function runPackage(pkg: PackageInfo) {
    if (!activeProject) return;
    addDev(activeProject.id, pkg.name, pkg.path, pkg.devCommand);
  }

  function runAll() {
    const ws = activeProject?.workspace;
    if (!activeProject || !ws) return;
    if (ws.allCommand) {
      addDev(activeProject.id, "all", activeProject.path, ws.allCommand);
    } else {
      ws.packages.forEach((p) =>
        addDev(activeProject.id, p.name, p.path, p.devCommand)
      );
    }
  }

  return { customCommand, setCustomCommand, runCustom, runPackage, runAll };
}

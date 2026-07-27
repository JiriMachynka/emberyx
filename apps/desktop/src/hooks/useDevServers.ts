import { useState } from "react";
import {
  getProjectConfigs,
  setProjectDevCommand,
  setProjectBuildCommand,
  setProjectStartCommand,
} from "@/lib/projectConfig";
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

  // Raw per-project overrides (empty when unset) drive the settings inputs;
  // the effective command falls back to the workspace-detected default and
  // drives the run buttons. Detected defaults feed the input placeholders.
  const ws = activeProject?.workspace ?? null;
  const cfg = activeProject ? configs[activeProject.path] : undefined;
  const buildCommandOverride = cfg?.buildCommand ?? "";
  const startCommandOverride = cfg?.startCommand ?? "";
  const detectedBuildCommand = ws?.buildCommand ?? "";
  const detectedStartCommand = ws?.startCommand ?? "";
  const buildCommand = buildCommandOverride || detectedBuildCommand;
  const startCommand = startCommandOverride || detectedStartCommand;
  const isPython = ws?.isPython ?? false;

  function setCustomCommand(command: string) {
    if (!activeProject) return;
    setConfigs(setProjectDevCommand(activeProject.path, command));
  }

  function setBuildCommand(command: string) {
    if (!activeProject) return;
    setConfigs(setProjectBuildCommand(activeProject.path, command));
  }

  function setStartCommand(command: string) {
    if (!activeProject) return;
    setConfigs(setProjectStartCommand(activeProject.path, command));
  }

  function runCustom() {
    if (!activeProject || !customCommand) return;
    addDev(activeProject.id, "dev", activeProject.path, customCommand);
  }

  function runBuild() {
    if (!activeProject || !buildCommand) return;
    addDev(activeProject.id, "build", activeProject.path, buildCommand);
  }

  function runStart() {
    if (!activeProject || !startCommand) return;
    addDev(activeProject.id, "start", activeProject.path, startCommand);
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

  return {
    customCommand,
    setCustomCommand,
    buildCommand,
    startCommand,
    buildCommandOverride,
    startCommandOverride,
    detectedBuildCommand,
    detectedStartCommand,
    setBuildCommand,
    setStartCommand,
    isPython,
    runCustom,
    runBuild,
    runStart,
    runPackage,
    runAll,
  };
}

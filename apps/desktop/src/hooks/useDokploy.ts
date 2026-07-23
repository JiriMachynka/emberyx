import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import type { DokployMatch, DokployService, Project } from "@/types";

interface DokployOptions {
  url: string;
  apiKey: string;
  setMatch: (projectId: string, match: DokployMatch | null) => void;
  openLogs: (
    projectId: string,
    cwd: string,
    service: { kind: string; id: string; name: string }
  ) => void;
}

/** Dokploy actions for a project: match it to a deployment by git remote,
 *  redeploy a service, and open a live log pane. All no-ops until the server
 *  URL and API key are configured in settings. */
export function useDokploy({ url, apiKey, setMatch, openLogs }: DokployOptions) {
  const configured = !!url && !!apiKey;

  function refresh(projectId: string, path: string) {
    if (!configured) return;
    invoke<DokployMatch | null>("dokploy_services", { url, apiKey, cwd: path })
      .then((m) => setMatch(projectId, m))
      .catch((e) => {
        console.error("dokploy_services failed:", e);
        toast.error("Couldn't reach Dokploy", { description: String(e) });
      });
  }

  function redeploy(service: DokployService) {
    if (!configured || !service.id) return;
    invoke("dokploy_redeploy", { url, apiKey, kind: service.kind, id: service.id })
      .then(() => toast.success(`Redeploying ${service.name}…`))
      .catch((e) => toast.error("Redeploy failed", { description: String(e) }));
  }

  function viewLogs(project: Project, service: DokployService) {
    if (!configured || !service.id) return;
    openLogs(project.id, project.path, {
      kind: service.kind,
      id: service.id,
      name: service.name,
    });
  }

  return { refresh, redeploy, viewLogs };
}

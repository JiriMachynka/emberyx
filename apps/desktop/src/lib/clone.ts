import type { RemoteHost } from "@/lib/forge";

/** Where a clone was started from — the palette action, not the parsed host. */
export type CloneSource = RemoteHost | "url";

export type CloneTarget =
  | { kind: RemoteHost; repository: string }
  | { kind: "url"; url: string };

const OWNER_REPO = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

const stripGit = (value: string): string =>
  value.replace(/\.git$/i, "").replace(/\/+$/, "");

const looksLikeGitUrl = (value: string): boolean =>
  /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(value) || /\.git$/i.test(value);

const hostedKind = (host: string): RemoteHost | null => {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  return null;
};

/** Pull owner/repo (GitHub) or group/project (GitLab) out of a clone URL. */
export const parseHostedRepo = (input: string): CloneTarget | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const scp = /^git@([^:]+):(.+)$/i.exec(trimmed);
  if (scp) {
    const kind = hostedKind(scp[1]);
    const repository = stripGit(scp[2]);
    if (!kind || !OWNER_REPO.test(repository)) return { kind: "url", url: trimmed };
    if (kind === "github" && repository.split("/").length !== 2) return null;
    return { kind, repository };
  }

  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:" &&
      url.protocol !== "ssh:" &&
      url.protocol !== "git:"
    ) {
      return null;
    }
    const repository = stripGit(url.pathname).replace(/^\//, "");
    if (!repository) return null;
    const kind = hostedKind(url.hostname);
    if (!kind) return { kind: "url", url: trimmed };
    if (kind === "github") {
      const parts = repository.split("/");
      if (parts.length < 2) return null;
      return { kind: "github", repository: `${parts[0]}/${parts[1]}` };
    }
    const gitlab = repository.replace(/\/-\/.*$/, "");
    if (!OWNER_REPO.test(gitlab)) return null;
    return { kind: "gitlab", repository: gitlab };
  } catch {
    return null;
  }
};

/** Turn the clone field into a forge repo or a raw git URL. `null` is unusable. */
export const parseCloneInput = (
  raw: string,
  source: CloneSource
): CloneTarget | null => {
  const input = raw.trim();
  if (!input) return null;

  if (source === "url") {
    return looksLikeGitUrl(input) ? { kind: "url", url: input } : null;
  }

  const fromUrl = parseHostedRepo(input);
  if (fromUrl) {
    if (fromUrl.kind === "url") return null;
    if (fromUrl.kind !== source) return null;
    return fromUrl;
  }

  const repository = stripGit(input);
  if (!OWNER_REPO.test(repository)) return null;
  if (source === "github" && repository.split("/").length !== 2) return null;
  return { kind: source, repository };
};

/** Folder name `git clone` would create from this input. */
export const cloneDirectoryName = (raw: string): string => {
  const input = raw.trim();
  if (!input) return "";
  const parsed = parseHostedRepo(input);
  if (parsed && parsed.kind !== "url") {
    const parts = parsed.repository.split("/");
    return parts[parts.length - 1] ?? "";
  }
  const stripped = stripGit(input);
  const slash = stripped.lastIndexOf("/");
  const colon = stripped.lastIndexOf(":");
  const cut = Math.max(slash, colon);
  return (cut >= 0 ? stripped.slice(cut + 1) : stripped).trim();
};

export const joinCloneDest = (parent: string, name: string): string =>
  `${parent.replace(/\/+$/, "")}/${name}`;

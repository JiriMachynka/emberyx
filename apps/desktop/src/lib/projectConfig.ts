const KEY = "emberyx.projectConfig";

/** Per-project settings, keyed by the project's absolute path. */
export interface ProjectConfig {
  /** Custom dev command; overrides workspace detection when set. */
  devCommand?: string;
}

type Store = Record<string, ProjectConfig>;

export function getProjectConfigs(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

/** Set (or clear, when blank) a project's custom dev command. Returns the
 *  updated store so callers can drop it straight into state. */
export function setProjectDevCommand(path: string, command: string): Store {
  const store = getProjectConfigs();
  const trimmed = command.trim();
  if (trimmed) {
    store[path] = { ...store[path], devCommand: trimmed };
  } else if (store[path]) {
    delete store[path].devCommand;
    if (Object.keys(store[path]).length === 0) delete store[path];
  }
  localStorage.setItem(KEY, JSON.stringify(store));
  return store;
}

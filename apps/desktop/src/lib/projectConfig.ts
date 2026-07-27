const KEY = "emberyx.projectConfig";

/** Per-project settings, keyed by the project's absolute path. */
export interface ProjectConfig {
  /** Custom dev command; overrides workspace detection when set. */
  devCommand?: string;
  /** Custom build command; overrides workspace detection when set. */
  buildCommand?: string;
  /** Custom start command for the built app; overrides detection when set. */
  startCommand?: string;
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

/** Set (or clear, when blank) one field on a project's config. Clearing a
 *  single field preserves the project's other fields; the entry is dropped
 *  only once every field is blank. Returns the updated store so callers can
 *  drop it straight into state. */
function setProjectField(
  path: string,
  field: keyof ProjectConfig,
  command: string
): Store {
  const store = getProjectConfigs();
  const trimmed = command.trim();
  if (trimmed) {
    store[path] = { ...store[path], [field]: trimmed };
  } else if (store[path]) {
    delete store[path][field];
    if (Object.keys(store[path]).length === 0) delete store[path];
  }
  localStorage.setItem(KEY, JSON.stringify(store));
  return store;
}

/** Set (or clear, when blank) a project's custom dev command. */
export function setProjectDevCommand(path: string, command: string): Store {
  return setProjectField(path, "devCommand", command);
}

/** Set (or clear, when blank) a project's custom build command. */
export function setProjectBuildCommand(path: string, command: string): Store {
  return setProjectField(path, "buildCommand", command);
}

/** Set (or clear, when blank) a project's custom start command. */
export function setProjectStartCommand(path: string, command: string): Store {
  return setProjectField(path, "startCommand", command);
}

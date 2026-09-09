import type { ActivityItem, ActivityKind } from "@/types";

/** Anything that can carry a turn's activity rows — a live draft or a settled
 *  message. Structural on purpose, so this stays free of the chat hook. */
export interface ActivityCarrier {
  activities?: ActivityItem[];
}

/** Fold snapshots into a row list, replacing by id and appending what is new.
 *
 *  Rust sends whole rows, not appendable deltas, so an update is a replace —
 *  a dropped event is repaired by the next one and nothing is added twice.
 *  Returns a new array: a flushed message shares the old one's reference and
 *  must not change under React.
 */
export const upsertActivities = (
  existing: ActivityItem[] | undefined,
  incoming: ActivityItem[]
): ActivityItem[] => {
  const next = existing ? existing.slice() : [];
  // An index rather than a findIndex per item: a long turn's row list is
  // scanned once here instead of once per row in the snapshot.
  const at = new Map<string, number>();
  for (let i = 0; i < next.length; i++) at.set(next[i].id, i);
  for (const item of incoming) {
    const i = at.get(item.id);
    if (i === undefined) {
      at.set(item.id, next.length);
      next.push(item);
    } else next[i] = item;
  }
  return next;
};

export interface ActivityRouting {
  /** Rows belonging to the turn still streaming. */
  draft: ActivityItem[];
  /** Rows belonging to a turn already finalized, grouped by the message that
   *  owns them — a tool result that arrived after its message was published. */
  settled: Map<string, ActivityItem[]>;
}

/** A message that can own activity rows. Structural on purpose, so this stays
 *  free of the chat hook. */
export interface OwnedCarrier extends ActivityCarrier {
  id: string;
}

/** Which message owns each activity id, kept incrementally so routing a row is
 *  a map lookup instead of a scan of every row in the thread.
 *
 *  `count` and `head` are enough to tell the two shapes a message list changes
 *  in apart: a plain append (index only the new tail) from a prepended page or
 *  a truncation (rebuild). A message is never re-owned, so an entry only ever
 *  needs writing once. */
export interface OwnerIndex {
  owners: Map<string, string>;
  count: number;
  head: string | undefined;
}

export const emptyOwnerIndex = (): OwnerIndex => ({
  owners: new Map(),
  count: 0,
  head: undefined,
});

const indexOne = (owners: Map<string, string>, message: OwnedCarrier) => {
  if (!message.activities) return;
  for (const a of message.activities) owners.set(a.id, message.id);
};

/** Bring the index in step with the current message list. Mutates and returns
 *  the same index — it is per-pane bookkeeping held in a ref, not state. */
export const syncOwnerIndex = (
  index: OwnerIndex,
  messages: readonly OwnedCarrier[]
): OwnerIndex => {
  const appended = messages.length >= index.count && messages[0]?.id === index.head;
  if (!appended) index.owners.clear();
  for (let i = appended ? index.count : 0; i < messages.length; i++)
    indexOne(index.owners, messages[i]);
  index.count = messages.length;
  index.head = messages[0]?.id;
  return index;
};

/** Decide which message each snapshot belongs to, and remember the answer.
 *
 *  Routing is by where the id already lives rather than by a table of owners
 *  the caller has to clear: an unseen id is new work in the streaming turn;
 *  with no draft to hold it, it belongs to nothing and is dropped.
 */
export const routeActivities = (
  items: ActivityItem[],
  draft: OwnedCarrier | null,
  index: OwnerIndex
): ActivityRouting => {
  const routing: ActivityRouting = { draft: [], settled: new Map() };
  for (const item of items) {
    const owner = index.owners.get(item.id);
    if (owner !== undefined && (!draft || owner !== draft.id)) {
      const list = routing.settled.get(owner);
      if (list) list.push(item);
      else routing.settled.set(owner, [item]);
      continue;
    }
    if (!draft) continue;
    index.owners.set(item.id, draft.id);
    routing.draft.push(item);
  }
  return routing;
};

/** Classify a tool by name.
 *
 *  The same vocabulary as `kind_for_tool` in `src-tauri/src/activity.rs`, but
 *  not a duplicate of it: Claude's rows are already classified in Rust before
 *  they cross, so this only ever sees names Codex and the ACP backends emit —
 *  their own tools and whatever MCP servers they have loaded.
 *
 *  Matched on the last `__` segment, because an MCP tool arrives as
 *  `mcp__server__read_file` and the leading segments say who provides it, not
 *  what it does.
 */
export const kindForToolName = (name: string): ActivityKind => {
  const segments = name.split("__");
  switch ((segments[segments.length - 1] ?? name).toLowerCase()) {
    case "bash":
    case "bashoutput":
    case "shell":
    case "run":
    case "execute":
      return "command";
    case "edit":
    case "write":
    case "multiedit":
    case "notebookedit":
    case "apply_patch":
    case "applypatch":
      return "fileChange";
    case "read":
    case "read_file":
    case "view":
      return "fileRead";
    case "grep":
    case "search_files":
    case "codebase_search":
      return "fileSearch";
    case "glob":
    case "ls":
    case "list_dir":
    case "list_directory":
      return "fileList";
    case "websearch":
    case "webfetch":
    case "web_search":
      return "search";
    case "todowrite":
    case "exit_plan_mode":
    case "update_plan":
    case "plan":
      return "plan";
    default:
      return "tool";
  }
};

/** The compact subject for a tool call, by kind. Mirrors `target_for` in
 *  `activity.rs`: each backend spells its input keys differently enough that
 *  guessing one key is wrong, so the list per kind is short and explicit. */
const TARGET_KEYS: Record<ActivityKind, readonly string[]> = {
  command: ["command", "cmd"],
  fileChange: ["file_path", "path", "notebook_path", "filePath"],
  fileRead: ["file_path", "path", "notebook_path", "filePath"],
  fileSearch: ["pattern", "query", "regex"],
  fileList: ["path", "pattern", "dir"],
  search: ["query", "url", "prompt"],
  plan: [],
  tool: [],
  reasoning: [],
};

export const targetForInput = (kind: ActivityKind, input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS[kind]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

/** What a backend knows about one row; everything else is the merge, which is
 *  the same for all of them. */
export interface ActivityRowSource {
  id: string;
  kind: ActivityKind;
  title: string;
  /** The tool's raw input. `undefined` means the backend sent none — not the
   *  same as an empty object, which is an input that happens to be empty. */
  input: unknown;
  /** The result so far, or `undefined` while there is none. An empty string is
   *  no result: pass `undefined` rather than blanking what already streamed in. */
  output?: string;
  /** `undefined` until the call settles, so a running row keeps the verdict the
   *  previous snapshot carried. */
  failed?: boolean;
  complete: boolean;
}

/** Build one activity row, folding in the row it revises.
 *
 *  Both TypeScript-side normalizers replace a row wholesale on every update —
 *  ACP sends `tool_call` then any number of `tool_call_update`s, Codex restates
 *  an item on completion — so a later snapshot that carries no output, no
 *  target or no verdict must not erase the one an earlier snapshot did. That
 *  merge is the shared half; what a row *is* stays with the backend that knows.
 */
export const buildActivityRow = (
  source: ActivityRowSource,
  previous?: ActivityItem
): ActivityItem => ({
  id: source.id,
  kind: source.kind,
  title: source.title,
  // A command's argument *is* its target; repeating it as a JSON blob shows the
  // same string twice in the disclosure.
  arguments:
    source.kind === "command" || source.input === undefined
      ? undefined
      : JSON.stringify(source.input, null, 2),
  output: source.output ?? previous?.output,
  displayTarget: targetForInput(source.kind, source.input) ?? previous?.displayTarget,
  failed: source.failed ?? previous?.failed ?? false,
  complete: source.complete,
});

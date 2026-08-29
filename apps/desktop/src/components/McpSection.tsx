import { useState } from "react";
import { ChevronDown, Globe, Plug, Plus, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  useMcpAdd,
  useMcpRemove,
  useMcpServers,
  useProviderStatus,
} from "@/lib/queries";
import {
  entryFor,
  MCP_HARNESS_LABEL,
  MCP_HARNESS_ORDER,
  transportSummary,
  type McpHarness,
  type McpHarnessEntry,
  type McpServerInfo,
} from "@/lib/mcp";
import { McpAddDialog } from "@/components/McpAddDialog";
import { Group } from "@/components/SettingsFields";

/** Settings → MCP: every MCP server across the harness configs, merged by
 *  name. The harness files stay the source of truth — this surface reads them
 *  back and writes through, it does not own the state. */
export function McpSection() {
  const servers = useMcpServers();
  const providers = useProviderStatus().data ?? [];
  const addMcp = useMcpAdd();
  const removeMcp = useMcpRemove();
  const [addOpen, setAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<{
    server: McpServerInfo;
    entry: McpHarnessEntry;
  } | null>(null);

  const installed = new Set(
    providers.filter((p) => p.installed).map((p) => p.id)
  );

  const list = servers.data ?? [];
  const connections = list.reduce((sum, s) => sum + s.harnesses.length, 0);

  return (
    <>
      <Group
        title="Servers"
        hint="Merged from each harness's own config file — servers added by the CLIs themselves show up here on the next read."
      >
        {list.length > 0 ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-muted-foreground tabular-nums">
                {list.length} server{list.length === 1 ? "" : "s"} ·{" "}
                {connections} connection{connections === 1 ? "" : "s"}
              </p>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="size-3.5" />
                Connect another MCP
              </Button>
            </div>

            <div className="grid gap-1.5">
              {list.map((server) => {
                const open = expanded === server.name;
                const hasClaudeSource = entryFor(server, "claude") !== undefined;
                const absent = MCP_HARNESS_ORDER.filter(
                  (harness) => entryFor(server, harness) === undefined
                );
                // `McpHarnessEntry[]` permits empty, and an empty one used to take
                // down the whole server list rather than skipping its row.
                const transport = server.harnesses[0]?.transport;
                if (!transport) return null;
                return (
                  <div
                    key={server.name}
                    className="surface-raised rounded-lg border bg-card/40 transition-colors hover:border-foreground/15"
                  >
                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : server.name)}
                      className="flex w-full items-center justify-between gap-4 rounded-lg px-3 py-2.5 text-left"
                    >
                      <span className="grid min-w-0 gap-1">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {server.name}
                          {server.differs && (
                            <span className="flex items-center gap-1.5 text-xs font-normal text-amber-600 dark:text-amber-500">
                              <span className="size-1.5 rounded-full bg-amber-500/80" />
                              differs across harnesses
                            </span>
                          )}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          {transport.kind === "stdio" ? (
                            <Terminal className="size-3 shrink-0" />
                          ) : (
                            <Globe className="size-3 shrink-0" />
                          )}
                          <code className="truncate">{transportSummary(transport)}</code>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {MCP_HARNESS_ORDER.map((harness) => (
                          <HarnessChip
                            key={harness}
                            harness={harness}
                            entry={entryFor(server, harness)}
                            hasClaudeSource={hasClaudeSource}
                          />
                        ))}
                        <ChevronDown
                          className={cn(
                            "size-4 text-muted-foreground transition-transform duration-200",
                            open && "rotate-180"
                          )}
                        />
                      </span>
                    </button>

                    {open && (
                      <div className="grid gap-1.5 rounded-b-lg border-t bg-canvas/50 px-3 py-3 animate-in fade-in-0 slide-in-from-top-1 duration-150">
                        {server.harnesses.map((entry) => (
                          <div
                            key={entry.harness}
                            className="flex items-center justify-between gap-3 text-sm"
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <img
                                src={`/provider-icons/${entry.harness}.svg`}
                                alt=""
                                className="size-4 shrink-0 object-contain"
                              />
                              <span className="shrink-0">
                                {MCP_HARNESS_LABEL[entry.harness]}
                              </span>
                              {!entry.enabled && (
                                <span className="shrink-0 text-xs text-amber-600 dark:text-amber-500">
                                  disabled in config
                                </span>
                              )}
                              <code className="truncate text-xs text-muted-foreground">
                                {entry.configPath}
                              </code>
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="shrink-0 text-destructive hover:text-destructive"
                              onClick={() => setPendingRemove({ server, entry })}
                            >
                              Disconnect
                            </Button>
                          </div>
                        ))}
                        {absent.length > 0 && (
                          <div className="flex items-center justify-between gap-3 pt-1.5">
                            <span className="text-sm text-muted-foreground">
                              Connect to
                            </span>
                            <span className="flex flex-wrap justify-end gap-1.5">
                              {absent.map((harness) => (
                                <button
                                  key={harness}
                                  type="button"
                                  title={
                                    installed.has(harness)
                                      ? undefined
                                      : `${MCP_HARNESS_LABEL[harness]} isn't installed`
                                  }
                                  onClick={() =>
                                    addMcp.mutate({
                                      name: server.name,
                                      harnesses: [harness],
                                      transport,
                                    })
                                  }
                                  className="flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                                >
                                  <Plus className="size-3" />
                                  <img
                                    src={`/provider-icons/${harness}.svg`}
                                    alt=""
                                    className="size-3.5 object-contain"
                                  />
                                  {MCP_HARNESS_LABEL[harness]}
                                </button>
                              ))}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : servers.isPending ? (
          <div className="grid gap-1.5" aria-hidden>
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-12 animate-pulse rounded-lg bg-secondary/40"
              />
            ))}
          </div>
        ) : servers.isError ? (
          <p className="text-sm text-destructive">
            Couldn't read harness configs: {errorText(servers.error)}
          </p>
        ) : (
          <div className="grid place-items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Plug className="size-4" />
            </span>
            <div className="grid gap-1">
              <p className="text-sm font-medium">No MCP servers configured</p>
              <p className="mx-auto max-w-sm text-xs text-muted-foreground">
                Added servers become tools your agents can call — search,
                databases, issue trackers.
              </p>
            </div>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-3.5" />
              Connect another MCP
            </Button>
          </div>
        )}
      </Group>

      <McpAddDialog open={addOpen} onOpenChange={setAddOpen} />

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(o) => !o && setPendingRemove(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Disconnect {pendingRemove ? pendingRemove.server.name : ""} from{" "}
              {pendingRemove
                ? MCP_HARNESS_LABEL[pendingRemove.entry.harness]
                : ""}
              ?
            </DialogTitle>
            <DialogDescription>
              {pendingRemove?.entry.harness === "claude"
                ? "Claude has no per-server switch, so this deletes the entry from its config."
                : `Removes the entry from ${
                    pendingRemove?.entry.configPath ?? "its config file"
                  }.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPendingRemove(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingRemove) {
                  removeMcp.mutate({
                    name: pendingRemove.server.name,
                    harness: pendingRemove.entry.harness,
                  });
                  setPendingRemove(null);
                }
              }}
            >
              Disconnect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Collapsed-row status: the harness's own icon, a corner dot for state.
 *  Icon-only keeps five harnesses legible where five text pills wouldn't be;
 *  the title carries the name and where the entry lives. */
function HarnessChip({
  harness,
  entry,
  hasClaudeSource,
}: {
  harness: McpHarness;
  entry: McpHarnessEntry | undefined;
  hasClaudeSource: boolean;
}) {
  const label = MCP_HARNESS_LABEL[harness];
  if (!entry) {
    // Grok also imports Claude's (and Cursor's) servers via compat, so an
    // absent Grok entry can still mean the server is live there — ember dot,
    // not a dead-looking one.
    const viaClaude = harness === "grok" && hasClaudeSource;
    return (
      <span
        title={
          viaClaude
            ? `${label} imports Claude's servers via compat`
            : `${label}: not connected`
        }
        className={cn(
          "relative grid size-6 place-items-center rounded-full border border-dashed",
          viaClaude && "border-primary/30"
        )}
      >
        <img
          src={`/provider-icons/${harness}.svg`}
          alt=""
          className="size-3.5 object-contain opacity-35"
        />
        {viaClaude && (
          <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-primary/90" />
        )}
      </span>
    );
  }
  return (
    <span
      title={`${label}: ${entry.enabled ? "connected" : "disabled in config"} — ${entry.configPath}`}
      className="relative grid size-6 place-items-center rounded-full bg-secondary/70"
    >
      <img
        src={`/provider-icons/${harness}.svg`}
        alt=""
        className="size-3.5 object-contain"
      />
      <span
        className={cn(
          "absolute -bottom-0.5 -right-0.5 size-2 rounded-full",
          entry.enabled ? "bg-emerald-500" : "bg-amber-500"
        )}
      />
    </span>
  );
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

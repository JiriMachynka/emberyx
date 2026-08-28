import { useEffect, useState } from "react";
import { Globe, Plus, Terminal, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useMcpAdd, useProviderStatus } from "@/lib/queries";
import {
  buildMcpTransport,
  DOKPLOY_MCP_PRESET,
  isValidMcpName,
  MCP_HARNESS_LABEL,
  MCP_HARNESS_ORDER,
  type McpHarness,
} from "@/lib/mcp";

interface McpAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Pair {
  name: string;
  value: string;
}

const newPair = (): Pair => ({ name: "", value: "" });

/** Connect a new MCP server: one definition, written into each selected
 *  harness's own config file. Form state follows the ActionDialog pattern —
 *  local state, reseeded whenever the dialog opens. */
export function McpAddDialog({ open, onOpenChange }: McpAddDialogProps) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [commandLine, setCommandLine] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState<Pair[]>([]);
  const [headers, setHeaders] = useState<Pair[]>([]);
  const [targets, setTargets] = useState<McpHarness[]>(["claude"]);
  const providers = useProviderStatus().data ?? [];
  const addMcp = useMcpAdd();

  useEffect(() => {
    if (!open) return;
    setName("");
    setKind("stdio");
    setCommandLine("");
    setUrl("");
    setEnv([]);
    setHeaders([]);
    setTargets(["claude"]);
  }, [open]);

  const installed = new Set(providers.filter((p) => p.installed).map((p) => p.id));

  const transport = buildMcpTransport({ kind, commandLine, url, env, headers });
  const nameError =
    name.trim() !== "" && !isValidMcpName(name.trim())
      ? "Letters, digits, - and _ only — every harness validates this."
      : null;
  const canConnect =
    transport !== null && nameError === null && isValidMcpName(name.trim()) && targets.length > 0;

  const connect = () => {
    if (!transport) return;
    addMcp.mutate(
      { name: name.trim(), harnesses: targets, transport },
      { onSuccess: () => onOpenChange(false) }
    );
  };

  const applyDokploy = () => {
    setName(DOKPLOY_MCP_PRESET.name);
    setKind("stdio");
    setCommandLine(DOKPLOY_MCP_PRESET.commandLine);
    setEnv(DOKPLOY_MCP_PRESET.env.map((row) => ({ ...row })));
    setHeaders([]);
  };

  const mutationError = addMcp.error;
  const errorText =
    mutationError instanceof Error
      ? mutationError.message
      : mutationError
        ? String(mutationError)
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect an MCP server</DialogTitle>
          <DialogDescription>
            Written into each selected harness's own config file. Servers can
            also be connected later from the list.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Start from</span>
            <button
              type="button"
              onClick={applyDokploy}
              className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              Dokploy
            </button>
          </div>

          <label className="grid gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="context7"
              spellCheck={false}
              autoFocus
            />
            {nameError && (
              <span className="text-xs text-destructive">{nameError}</span>
            )}
          </label>

          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Transport</span>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  {
                    id: "stdio",
                    label: "Command",
                    hint: "A local process, launched over stdio",
                    icon: Terminal,
                  },
                  {
                    id: "http",
                    label: "URL",
                    hint: "A remote server, reached over HTTP",
                    icon: Globe,
                  },
                ] as const
              ).map(({ id, label, hint, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setKind(id)}
                  className={cn(
                    "grid gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                    kind === id
                      ? "border-foreground/25 bg-secondary/40"
                      : "hover:border-foreground/15"
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="size-3.5 text-muted-foreground" />
                    {label}
                  </span>
                  <span className="text-xs text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {kind === "stdio" ? (
            <label className="grid gap-1.5">
              <span className="text-sm font-medium">Command</span>
              <Input
                value={commandLine}
                onChange={(e) => setCommandLine(e.target.value)}
                placeholder="npx -y @upstash/context7-mcp"
                spellCheck={false}
                className="font-mono text-sm"
              />
              <span className="text-xs text-muted-foreground">
                Run directly, never through a shell. Quotes group arguments.
              </span>
            </label>
          ) : (
            <label className="grid gap-1.5">
              <span className="text-sm font-medium">URL</span>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.context7.com/mcp"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </label>
          )}

          {kind === "stdio" ? (
            <>
              <PairRows
                label="Environment variables"
                addLabel="Add variable"
                rows={env}
                setRows={setEnv}
              />
              {env.some((row) => row.name === "DOKPLOY_URL") && (
                <p className="text-xs text-muted-foreground">
                  DOKPLOY_URL needs the /api path, e.g.
                  https://dokploy.example.com/api
                </p>
              )}
            </>
          ) : (
            <PairRows
              label="Headers"
              addLabel="Add header"
              rows={headers}
              setRows={setHeaders}
            />
          )}

          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Connect to</span>
            <div className="flex flex-wrap gap-1.5">
              {MCP_HARNESS_ORDER.map((harness) => {
                const selected = targets.includes(harness);
                const isInstalled = installed.has(harness);
                return (
                  <button
                    key={harness}
                    type="button"
                    title={
                      isInstalled
                        ? undefined
                        : `${MCP_HARNESS_LABEL[harness]} isn't installed — the config is written anyway`
                    }
                    onClick={() =>
                      setTargets((prev) =>
                        prev.includes(harness)
                          ? prev.filter((t) => t !== harness)
                          : [...prev, harness]
                      )
                    }
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      selected
                        ? "border-foreground/30 bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        selected
                          ? isInstalled
                            ? "bg-emerald-500"
                            : "bg-amber-500"
                          : "bg-muted-foreground/30"
                      )}
                    />
                    <img
                      src={`/provider-icons/${harness}.svg`}
                      alt=""
                      className="size-3.5 object-contain"
                    />
                    {MCP_HARNESS_LABEL[harness]}
                  </button>
                );
              })}
            </div>
          </div>

          {errorText && (
            <p className="text-xs text-destructive">{errorText}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={connect} disabled={!canConnect || addMcp.isPending}>
            {addMcp.isPending ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Editable name/value rows — env vars for stdio, headers for HTTP. */
function PairRows({
  label,
  addLabel,
  rows,
  setRows,
}: {
  label: string;
  addLabel: string;
  rows: Pair[];
  setRows: (rows: Pair[]) => void;
}) {
  const update = (index: number, patch: Partial<Pair>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={row.name}
            onChange={(e) => update(index, { name: e.target.value })}
            placeholder="NAME"
            spellCheck={false}
            className="font-mono text-sm"
          />
          <Input
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            placeholder="value"
            spellCheck={false}
            className="font-mono text-sm"
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Remove row"
            onClick={() => setRows(rows.filter((_, i) => i !== index))}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRows([...rows, newPair()])}
        >
          <Plus className="size-3.5" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function LaunchEnvRows({
  rows,
  onChange,
}: {
  rows: { name: string; value: string }[];
  onChange: (rows: { name: string; value: string }[]) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">Environment</span>
      <span className="text-xs text-muted-foreground">
        Injected into the agent process. Use this for ANTHROPIC_BASE_URL /
        ANTHROPIC_AUTH_TOKEN.
      </span>
      <div className="grid gap-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              value={row.name}
              onChange={(e) =>
                onChange(
                  rows.map((r, i) =>
                    i === index ? { ...r, name: e.target.value } : r
                  )
                )
              }
              placeholder="NAME"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <Input
              value={row.value}
              onChange={(e) =>
                onChange(
                  rows.map((r, i) =>
                    i === index ? { ...r, value: e.target.value } : r
                  )
                )
              }
              placeholder="value"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label="Remove variable"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([...rows, { name: "", value: "" }])}
          >
            <Plus className="size-3.5" />
            Add variable
          </Button>
        </div>
      </div>
    </div>
  );
}

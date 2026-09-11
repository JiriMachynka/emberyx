import { ArrowRightLeft } from "lucide-react";
import { PROVIDER_LABEL } from "@/lib/providers";
import type { ProviderSwitchMark } from "@/lib/thread";

/** Where the thread changed hands. Rendered in the transcript rather than as a
 *  toast, because which provider wrote which turn is part of reading it back. */
export function ProviderSwitchDivider({ mark }: { mark: ProviderSwitchMark }) {
  return (
    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        <ArrowRightLeft className="size-3" />
        {`${PROVIDER_LABEL[mark.from]} → ${PROVIDER_LABEL[mark.to]}`}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

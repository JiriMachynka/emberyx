import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Close/stop affordance for a tab; hover-revealed unless the tab is active. */
export function TabCloseButton({
  active,
  title,
  onClose,
}: {
  active: boolean;
  title: string;
  onClose: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className={cn(
        "rounded p-0.5 transition-opacity hover:bg-accent",
        active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}
      title={title}
    >
      <X className="size-3" />
    </button>
  );
}

/** Amber bar prompting the user to jump to an agent awaiting input. */
export function AttentionBanner({ onJump }: { onJump: () => void }) {
  return (
    <button
      onClick={onJump}
      className="flex h-7 shrink-0 items-center justify-center gap-2 bg-amber-500/15 text-xs text-amber-300 hover:bg-amber-500/25"
    >
      <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
      Claude needs your input — click to jump to the agent
    </button>
  );
}

/** Amber bar prompting the user to jump to an agent awaiting input. */
export function AttentionBanner({ onJump }: { onJump: () => void }) {
  return (
    <button
      onClick={onJump}
      className="flex h-7 shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-gradient-to-b from-amber-500/20 to-amber-500/10 text-xs text-amber-300 transition-colors hover:from-amber-500/30 hover:to-amber-500/15"
    >
      <span className="size-1.5 animate-ember-pulse rounded-full bg-amber-400 text-amber-400" />
      Claude needs your input — click to jump to the agent
    </button>
  );
}

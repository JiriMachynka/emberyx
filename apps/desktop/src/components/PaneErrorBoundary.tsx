/**
 * A crash barrier around one pane.
 *
 * Panes render provider-shaped payloads — tool cards, diffs, transcripts — from
 * three transports, one of which (`codex app-server`) is flagged experimental
 * and has renamed its methods before. An `undefined` deref in a single tool card
 * used to unmount the whole tree to a white window, taking every other project's
 * panes with it. Since the app kills its children on exit, the only recovery was
 * to quit and lose every running agent.
 *
 * So the blast radius is one pane, and the agent behind it keeps running: the
 * boundary replaces the rendering, not the session.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  /** Shown so the user knows which surface failed, not just that one did. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class PaneErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[emberyx] pane crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {this.props.label ?? "This pane"} stopped rendering.
          </p>
          {/* The agent is a separate process — say so, or closing the tab looks
              like the only option and that is what kills the work. */}
          <p className="max-w-sm text-xs text-muted-foreground">
            The agent is still running. Retrying re-renders the pane without
            touching the session.
          </p>
          <p className="max-w-sm break-words font-mono text-xs text-muted-foreground/70">
            {error.message}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => this.setState({ error: null })}
        >
          <RotateCcw />
          Retry
        </Button>
      </div>
    );
  }
}

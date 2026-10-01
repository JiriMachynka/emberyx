import { useCallback } from "react";
import { agentPhase } from "@/lib/agentPhase";
import { useAgentStore } from "@/lib/agentStore";
import type { ChatMessage, ChatStatus } from "@/lib/chatMessage";

/** Mirror what the agent is doing into the store. Every chat hook calls it
 *  where its draft or status changes — not from a render, which a hidden pane
 *  skips — so the sidebar describes a background thread as it runs. The store
 *  drops a write that says nothing new, so calling it per delta is cheap. */
export const useAgentPhase = (sessionId: string, enabled: boolean) => {
  const setPhase = useAgentStore((s) => s.setPhase);
  return useCallback(
    (status: ChatStatus, draft: ChatMessage | null | undefined) => {
      if (enabled) setPhase(sessionId, agentPhase(status, draft));
    },
    [enabled, sessionId, setPhase]
  );
};

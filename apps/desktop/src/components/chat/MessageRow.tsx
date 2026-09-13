import { memo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Check, Copy, Undo2 } from "lucide-react";
import { TextWithFileRefs } from "@/components/FileRef";
import { Markdown } from "@/components/Markdown";
import { splitFencedBlocks } from "@/lib/fileRef";
import { capabilitiesOf, type AgentBackend } from "@/lib/agentBackend";
import type { ChatMessage } from "@/hooks/useAgentChat";
import { useInvalidateGit } from "@/lib/queries";
import {
  checkpointChanges,
  describeRestore,
  restoreCheckpoint,
} from "@/lib/checkpoints";
import { imageSrc } from "@/components/chat/imageSrc";
import { MessageWork } from "@/components/chat/MessageWork";

/** Memoized: while a message is streaming only its own row re-renders, and
 *  typing in the composer re-renders none of them. */
export const MessageRow = memo(function MessageRow({
  message,
  fontSize,
  chat,
  onPreview,
}: {
  message: ChatMessage;
  fontSize: number;
  chat: ChatContext;
  onPreview: (dataUrl: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {message.images && message.images.length > 0 && (
          <div className="flex max-w-prose flex-wrap justify-end gap-2">
            {message.images.map((img) => (
              <button
                key={img.id}
                type="button"
                onClick={() => onPreview(imageSrc(img))}
                className="size-20 overflow-hidden rounded-lg border border-border"
              >
                <img
                  src={imageSrc(img)}
                  alt=""
                  className="size-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {message.text && (
          <div className="chat-bubble max-w-prose rounded-2xl px-4 py-2.5 text-foreground/90">
            {splitFencedBlocks(message.text).map((part, i) =>
              part.kind === "fence" ? (
                <div key={i} className="min-w-0 overflow-x-auto">
                  <Markdown text={part.text} fontSize={fontSize} />
                </div>
              ) : (
                <span key={i} className="whitespace-pre-wrap">
                  <TextWithFileRefs text={part.text} />
                </span>
              )
            )}
          </div>
        )}
        {message.checkpointId && (
          <RevertTurnButton
            projectPath={chat.cwd}
            threadId={chat.sessionId}
            checkpointId={message.checkpointId}
            rewindConversation={capabilitiesOf(chat.backend).conversationRewind}
            onRevertConversation={chat.revertTurn}
          />
        )}
      </div>
    );
  }
  return (
    <div className="group relative flex flex-col gap-2">
      <MessageWork
        message={message}
        active={message.streaming && !message.text && message.tools.length === 0}
      />
      {message.text && (
        <Markdown text={message.text} fontSize={fontSize} streaming={message.streaming} />
      )}
      {message.text && !message.streaming && (
        <MessageActions text={message.text} />
      )}
    </div>
  );
});

/** What a message action needs about the chat it was rendered in. */
export interface ChatContext {
  sessionId: string;
  cwd: string;
  backend: AgentBackend;
  revertTurn: (checkpointId: string) => Promise<void>;
}

/** The hover strip under an assistant message. */
export function MessageActions({ text }: { text: string }) {
  return (
    <div className="absolute left-0 top-full flex w-fit items-center gap-1 text-xs opacity-0 transition-opacity group-hover:opacity-100">
      <CopyButton text={text} />
    </div>
  );
}

const actionClass =
  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" onClick={copy} title="Copy message" className={actionClass}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Old vs new for an Edit, as a syntax-highlighted unified diff. */
function RevertTurnButton({
  projectPath,
  threadId,
  checkpointId,
  rewindConversation,
  onRevertConversation,
}: {
  projectPath: string;
  threadId: string;
  checkpointId: string;
  rewindConversation: boolean;
  onRevertConversation: (checkpointId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const invalidateGit = useInvalidateGit();

  const revert = async () => {
    setBusy(true);
    try {
      const changes = await checkpointChanges(projectPath, checkpointId);
      if (changes.length === 0 && !rewindConversation) {
        toast.info("Nothing to revert", {
          description: "The working tree is unchanged since this turn.",
        });
        return;
      }
      const added = changes.filter((c) => c.kind === "added");
      const question = rewindConversation
        ? changes.length > 0
          ? `${describeRestore(changes)}.\n\nRestore the working tree and drop this turn from the conversation?`
          : "Drop this turn and everything after it from the conversation?"
        : `${describeRestore(changes)}.\n\nRestore the working tree to before this turn?`;
      const ok = await ask(question, { title: "Revert turn", kind: "warning" });
      if (!ok) return;
      // Deleting files created since the checkpoint is a second, separate ask:
      // some of them are the agent's, some may be the user's own.
      const removeAdded =
        added.length > 0 &&
        (await ask(
          `Also delete ${added.length} file(s) created since this turn?\n\n${added
            .slice(0, 8)
            .map((c) => c.path)
            .join("\n")}`,
          { title: "Delete new files", kind: "warning" }
        ));
      // Provider first: if rewind fails the tree still matches the conversation.
      if (rewindConversation) await onRevertConversation(checkpointId);
      if (changes.length > 0) {
        await restoreCheckpoint(projectPath, checkpointId, removeAdded);
        invalidateGit(projectPath);
      }
      // A revert is a durable fact about the thread, not just a toast.
      void invoke("thread_timeline_append", {
        threadId,
        kind: "checkpointReverted",
        attribution: null,
        payload: JSON.stringify({
          checkpointId,
          removeAdded,
          changes: changes.length,
          conversation: rewindConversation,
        }),
      }).catch(() => {});
      toast.success("Reverted to before this turn");
    } catch (e) {
      toast.error("Revert failed", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void revert()}
      disabled={busy}
      title={
        rewindConversation
          ? "Restore the working tree and conversation to before this turn"
          : "Restore the working tree to before this turn"
      }
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground group-hover:opacity-100 disabled:opacity-40"
    >
      <Undo2 className="size-3.5" />
      Revert turn
    </button>
  );
}

import type { ChatMessage as ChatMessageType } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import NodeWorkspace from "./NodeWorkspace";

type ChatPanelProps = {
  messages: ChatMessageType[];
  highlightedMessageIds: string[];
  isAssistantResponding: boolean;
  conversationId?: string | null;
  // Node workspace
  workspaceNode: ContextNode | null;
  workspaceLinkedMessages: ChatMessageType[];
  onExitWorkspace: () => void;
  // Actions
  onSendMessage: (content: string, attachments?: import("@/src/types/message").AttachmentMeta[]) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
};

export default function ChatPanel({
  messages,
  highlightedMessageIds,
  isAssistantResponding,
  conversationId,
  workspaceNode,
  workspaceLinkedMessages,
  onExitWorkspace,
  onSendMessage,
  onEditMessage,
}: ChatPanelProps) {
  // If a workspace node is active, render the focused workspace view
  if (workspaceNode) {
    return (
      <NodeWorkspace
        node={workspaceNode}
        linkedMessages={workspaceLinkedMessages}
        continuationMessages={messages}
        isAssistantResponding={isAssistantResponding}
        onBack={onExitWorkspace}
        onSendMessage={onSendMessage}
      />
    );
  }

  // Normal conversation view
  return (
    <section className="mx-auto flex h-screen max-w-3xl flex-col px-6 pt-24">
      {/* Message list — scrollable */}
      <div className="flex-1 overflow-y-auto space-y-5 pb-4">
        {messages.map((message, idx) => {
          // Determine if this is the latest user message (for edit branching info)
          const userMessages = messages.filter((m) => m.role === "user");
          const isLatestUser = message.role === "user" && userMessages.length > 0 && userMessages[userMessages.length - 1].id === message.id;

          return (
            <ChatMessage
              key={message.id}
              message={message}
              isSelected={false}
              isHighlighted={highlightedMessageIds.includes(message.id)}
              onEdit={onEditMessage}
              isLatestUserMessage={isLatestUser}
            />
          );
        })}

        {/* Typing indicator */}
        {isAssistantResponding && (
          <div className="flex items-center gap-2 rounded-2xl bg-blue-50 px-4 py-3">
            <span className="text-sm font-semibold text-gray-600">Assistant</span>
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          </div>
        )}
      </div>

      {/* Input — sticky at the bottom */}
      <div className="sticky bottom-0 bg-white pb-4 pt-2">
        <ChatInput
          onSendMessage={onSendMessage}
          disabled={isAssistantResponding}
          conversationId={conversationId}
        />
      </div>
    </section>
  );
}

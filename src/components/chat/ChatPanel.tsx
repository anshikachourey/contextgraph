import type { ChatMessage as ChatMessageType } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import NodeWorkspace from "./NodeWorkspace";

type ChatPanelProps = {
  messages: ChatMessageType[];
  highlightedMessageIds: string[];
  isAssistantResponding: boolean;
  // Node workspace
  workspaceNode: ContextNode | null;
  workspaceLinkedMessages: ChatMessageType[];
  onExitWorkspace: () => void;
  // Actions
  onSendMessage: (content: string) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
};

export default function ChatPanel({
  messages,
  highlightedMessageIds,
  isAssistantResponding,
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
    <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end px-6 pb-10 pt-24">
      {/* Message list */}
      <div className="mb-4 space-y-5">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            isSelected={false}
            isHighlighted={highlightedMessageIds.includes(message.id)}
            onEdit={onEditMessage}
          />
        ))}

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

      {/* Input */}
      <div className="mb-4">
        <ChatInput
          onSendMessage={onSendMessage}
          disabled={isAssistantResponding}
        />
      </div>
    </section>
  );
}

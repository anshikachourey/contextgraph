import type { ChatMessage as ChatMessageType } from "@/src/types/message";
import type { ContextNode } from "@/src/types/node";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import NodeWorkspace from "./NodeWorkspace";

type ChatPanelProps = {
  messages: ChatMessageType[];
  selectedMessageIds: string[];
  highlightedMessageIds: string[];
  isAssistantResponding: boolean;
  // Node workspace
  workspaceNode: ContextNode | null;
  workspaceLinkedMessages: ChatMessageType[];
  onExitWorkspace: () => void;
  // Actions
  onToggleMessage: (id: string) => void;
  onCreateNode: () => void;
  onSendMessage: (content: string) => void;
};

export default function ChatPanel({
  messages,
  selectedMessageIds,
  highlightedMessageIds,
  isAssistantResponding,
  workspaceNode,
  workspaceLinkedMessages,
  onExitWorkspace,
  onToggleMessage,
  onCreateNode,
  onSendMessage,
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
      {/* Selection toolbar */}
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {selectedMessageIds.length} message
          {selectedMessageIds.length === 1 ? "" : "s"} selected
        </p>

        <button
          onClick={onCreateNode}
          disabled={selectedMessageIds.length === 0}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          Create node
        </button>
      </div>

      {/* Message list */}
      <div className="mb-4 space-y-5">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            isSelected={selectedMessageIds.includes(message.id)}
            isHighlighted={highlightedMessageIds.includes(message.id)}
            onToggle={onToggleMessage}
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

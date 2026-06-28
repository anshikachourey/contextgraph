import type { ChatMessage as ChatMessageType } from "@/src/types/message";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";
import BranchBanner from "./BranchBanner";

type ChatPanelProps = {
  messages: ChatMessageType[];
  selectedMessageIds: string[];
  highlightedMessageIds: string[];
  isAssistantResponding: boolean;
  // Branch mode
  branchNodeTitle: string | null;
  onExitBranch: () => void;
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
  branchNodeTitle,
  onExitBranch,
  onToggleMessage,
  onCreateNode,
  onSendMessage,
}: ChatPanelProps) {
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
          <div key={message.id}>
            {/* Branch label for branch messages */}
            {message.parentNodeId && (
              <p className="mb-1 text-xs text-purple-500">
                ↳ Branch message
              </p>
            )}
            <ChatMessage
              message={message}
              isSelected={selectedMessageIds.includes(message.id)}
              isHighlighted={highlightedMessageIds.includes(message.id)}
              onToggle={onToggleMessage}
            />
          </div>
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

      {/* Branch banner */}
      {branchNodeTitle && (
        <div className="mb-3">
          <BranchBanner nodeTitle={branchNodeTitle} onExit={onExitBranch} />
        </div>
      )}

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

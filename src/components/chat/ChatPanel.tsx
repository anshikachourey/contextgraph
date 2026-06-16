import type { ChatMessage as ChatMessageType } from "@/src/types/message";
import ChatMessage from "./ChatMessage";
import ChatInput from "./ChatInput";

type ChatPanelProps = {
  messages: ChatMessageType[];
  selectedMessageIds: string[];
  onToggleMessage: (id: string) => void;
  onCreateNode: () => void;
};

export default function ChatPanel({
  messages,
  selectedMessageIds,
  onToggleMessage,
  onCreateNode,
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
      <div className="mb-8 space-y-5">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            isSelected={selectedMessageIds.includes(message.id)}
            onToggle={onToggleMessage}
          />
        ))}
      </div>

      {/* Input */}
      <ChatInput />
    </section>
  );
}

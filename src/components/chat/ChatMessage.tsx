import type { ChatMessage as ChatMessageType } from "@/src/types/message";

type ChatMessageProps = {
  message: ChatMessageType;
  isSelected: boolean;
  onToggle: (id: string) => void;
};

export default function ChatMessage({
  message,
  isSelected,
  onToggle,
}: ChatMessageProps) {
  return (
    <button
      onClick={() => onToggle(message.id)}
      className={`w-full rounded-2xl p-4 text-left transition ${
        isSelected
          ? "ring-2 ring-black"
          : message.role === "user"
            ? "bg-gray-100"
            : "bg-blue-50"
      }`}
    >
      <p className="text-sm font-semibold text-gray-600">
        {message.role === "user" ? "You" : "Assistant"}
      </p>
      <p className="mt-1">{message.content}</p>
    </button>
  );
}

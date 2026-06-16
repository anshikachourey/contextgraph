import type { ChatMessage as ChatMessageType } from "@/src/types/message";

type ChatMessageProps = {
  message: ChatMessageType;
  isSelected: boolean;
  // Highlighted = linked to the currently active graph node
  isHighlighted: boolean;
  onToggle: (id: string) => void;
};

export default function ChatMessage({
  message,
  isSelected,
  isHighlighted,
  onToggle,
}: ChatMessageProps) {
  // Priority: selected > highlighted > default role styling
  const ringClass = isSelected
    ? "ring-2 ring-black"
    : isHighlighted
      ? "ring-2 ring-blue-500 bg-blue-50"
      : message.role === "user"
        ? "bg-gray-100"
        : "bg-blue-50";

  return (
    <button
      onClick={() => onToggle(message.id)}
      className={`w-full rounded-2xl p-4 text-left transition ${ringClass}`}
    >
      <p className="text-sm font-semibold text-gray-600">
        {message.role === "user" ? "You" : "Assistant"}
      </p>
      <p className="mt-1">{message.content}</p>
    </button>
  );
}

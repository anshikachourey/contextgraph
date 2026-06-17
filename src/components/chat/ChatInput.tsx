"use client";

import { useState } from "react";

type ChatInputProps = {
  onSendMessage: (content: string) => void;
  // Locked while the assistant is responding
  disabled?: boolean;
};

export default function ChatInput({ onSendMessage, disabled = false }: ChatInputProps) {
  const [value, setValue] = useState("");

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSendMessage(trimmed);
    setValue("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  const isDisabled = disabled || !value.trim();

  return (
    <div className="flex items-center rounded-2xl border border-gray-300 bg-white p-3 shadow-sm">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className="flex-1 outline-none disabled:cursor-not-allowed disabled:opacity-50"
        placeholder={disabled ? "Assistant is responding…" : "Ask ContextGraph..."}
      />
      <button
        onClick={handleSend}
        disabled={isDisabled}
        className="rounded-xl bg-black px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-gray-300"
      >
        Send
      </button>
    </div>
  );
}

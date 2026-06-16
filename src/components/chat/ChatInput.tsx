export default function ChatInput() {
  return (
    <div className="flex items-center rounded-2xl border border-gray-300 bg-white p-3 shadow-sm">
      <input
        className="flex-1 outline-none"
        placeholder="Ask ContextGraph..."
      />
      <button className="rounded-xl bg-black px-4 py-2 text-sm text-white">
        Send
      </button>
    </div>
  );
}

"use client";

import { useState } from "react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ContextNode = {
  id: string;
  title: string;
  summary: string;
  messageIds: string[];
};

const initialMessages: ChatMessage[] = [
  {
    id: "m1",
    role: "user",
    content: "Help me plan my AI startup.",
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "Let's start by identifying the core user problem, target audience, and first MVP loop.",
  },
  {
    id: "m3",
    role: "user",
    content:
      "The problem is that long AI chats become hard to navigate and the assistant loses context.",
  },
];

export default function Home() {
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isGraphMaximized, setIsGraphMaximized] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<ContextNode[]>([]);

  function toggleMessageSelection(messageId: string) {
    setSelectedMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  }

  function createNodeFromSelection() {
    if (selectedMessageIds.length === 0) return;

    const newNode: ContextNode = {
      id: crypto.randomUUID(),
      title: "Core Problem",
      summary:
        "Discussion about long AI chats becoming hard to navigate and losing context.",
      messageIds: selectedMessageIds,
    };

    setNodes((current) => [...current, newNode]);
    setSelectedMessageIds([]);
    setIsGraphOpen(true);
  }

  return (
    <main className="relative min-h-screen bg-white text-black">
      <header className="fixed left-0 right-0 top-0 z-20 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
        <div className="text-lg font-semibold">ContextGraph</div>

        <button
          onClick={() => setIsGraphOpen(true)}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Show Context Graph
        </button>
      </header>

      <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end px-6 pb-10 pt-24">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {selectedMessageIds.length} message
            {selectedMessageIds.length === 1 ? "" : "s"} selected
          </p>

          <button
            onClick={createNodeFromSelection}
            disabled={selectedMessageIds.length === 0}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            Create node
          </button>
        </div>

        <div className="mb-8 space-y-5">
          {initialMessages.map((message) => {
            const isSelected = selectedMessageIds.includes(message.id);

            return (
              <button
                key={message.id}
                onClick={() => toggleMessageSelection(message.id)}
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
          })}
        </div>

        <div className="flex items-center rounded-2xl border border-gray-300 bg-white p-3 shadow-sm">
          <input
            className="flex-1 outline-none"
            placeholder="Ask ContextGraph..."
          />
          <button className="rounded-xl bg-black px-4 py-2 text-sm text-white">
            Send
          </button>
        </div>
      </section>

      {isGraphOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20"
          onClick={() => {
            setIsGraphOpen(false);
            setIsGraphMaximized(false);
          }}
        />
      )}

      <aside
        className={`fixed right-0 top-0 z-40 h-full transform border-l border-gray-200 bg-white shadow-2xl transition-all duration-300 ${
          isGraphOpen ? "translate-x-0" : "translate-x-full"
        } ${isGraphMaximized ? "w-full" : "w-[460px]"}`}
      >
        <div className="flex h-16 items-center justify-between border-b border-gray-200 px-5">
          <h2 className="font-semibold">Context Graph</h2>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsGraphMaximized(!isGraphMaximized)}
              className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
            >
              {isGraphMaximized ? "Exit full screen" : "Maximize"}
            </button>

            <button
              onClick={() => {
                setIsGraphOpen(false);
                setIsGraphMaximized(false);
              }}
              className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
            >
              Close
            </button>
          </div>
        </div>

        <div className="h-[calc(100%-4rem)] bg-gray-50 p-6">
          {nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-gray-500">
              <div>
                <div className="mb-3 text-4xl">●──●</div>
                <p className="font-medium">No nodes yet</p>
                <p className="mt-1 text-sm">
                  Select chat messages and create your first context node.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {nodes.map((node) => (
                <div
                  key={node.id}
                  className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"
                >
                  <p className="font-semibold">{node.title}</p>
                  <p className="mt-2 text-sm text-gray-600">{node.summary}</p>
                  <p className="mt-3 text-xs text-gray-400">
                    {node.messageIds.length} linked message
                    {node.messageIds.length === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}
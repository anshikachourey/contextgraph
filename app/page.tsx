"use client";

import { useState } from "react";
import Header from "@/src/components/layout/Header";
import ChatPanel from "@/src/components/chat/ChatPanel";
import GraphDrawer from "@/src/components/graph/GraphDrawer";
import { mockMessages } from "@/src/data/mockMessages";
import type { ContextNode } from "@/src/types/node";

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

  function handleCloseGraph() {
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
  }

  return (
    <main className="relative min-h-screen bg-white text-black">
      <Header onShowGraph={() => setIsGraphOpen(true)} />

      <ChatPanel
        messages={mockMessages}
        selectedMessageIds={selectedMessageIds}
        onToggleMessage={toggleMessageSelection}
        onCreateNode={createNodeFromSelection}
      />

      <GraphDrawer
        isOpen={isGraphOpen}
        isMaximized={isGraphMaximized}
        nodes={nodes}
        onToggleMaximize={() => setIsGraphMaximized((prev) => !prev)}
        onClose={handleCloseGraph}
      />
    </main>
  );
}

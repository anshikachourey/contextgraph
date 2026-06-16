"use client";

import { useState } from "react";
import Header from "@/src/components/layout/Header";
import ChatPanel from "@/src/components/chat/ChatPanel";
import GraphDrawer from "@/src/components/graph/GraphDrawer";
import CreateNodeModal from "@/src/components/nodes/CreateNodeModal";
import { mockMessages } from "@/src/data/mockMessages";
import type { ContextNode } from "@/src/types/node";

export default function Home() {
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isGraphMaximized, setIsGraphMaximized] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<ContextNode[]>([]);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Derive the active node object and its linked messages from activeNodeId
  const activeNode = nodes.find((n) => n.id === activeNodeId) ?? null;
  const activeNodeMessages = activeNode
    ? mockMessages.filter((m) => activeNode.messageIds.includes(m.id))
    : [];

  // Derive highlighted message ids from the active node
  const highlightedMessageIds = activeNode?.messageIds ?? [];

  // Derive the full message objects for the modal preview
  const selectedMessages = mockMessages.filter((m) =>
    selectedMessageIds.includes(m.id),
  );

  function toggleMessageSelection(messageId: string) {
    setSelectedMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  }

  // "Create node" button — opens the modal instead of immediately creating
  function handleOpenModal() {
    if (selectedMessageIds.length === 0) return;
    setIsModalOpen(true);
  }

  // User confirmed in the modal — create the node with their typed values
  function handleModalConfirm(title: string, summary: string) {
    const newNode: ContextNode = {
      id: crypto.randomUUID(),
      title,
      summary,
      messageIds: selectedMessageIds,
    };

    setNodes((current) => [...current, newNode]);
    setSelectedMessageIds([]);
    setIsModalOpen(false);
    setIsGraphOpen(true);
  }

  // User cancelled — close modal, keep selection so they don't lose it
  function handleModalCancel() {
    setIsModalOpen(false);
  }

  function handleCloseGraph() {
    setIsGraphOpen(false);
    setIsGraphMaximized(false);
    setActiveNodeId(null);
  }

  function handleNodeClick(nodeId: string) {
    setActiveNodeId((current) => (current === nodeId ? null : nodeId));
  }

  return (
    <main className="relative min-h-screen bg-white text-black">
      <Header onShowGraph={() => setIsGraphOpen(true)} />

      <ChatPanel
        messages={mockMessages}
        selectedMessageIds={selectedMessageIds}
        highlightedMessageIds={highlightedMessageIds}
        onToggleMessage={toggleMessageSelection}
        onCreateNode={handleOpenModal}
      />

      <GraphDrawer
        isOpen={isGraphOpen}
        isMaximized={isGraphMaximized}
        nodes={nodes}
        activeNode={activeNode}
        activeNodeMessages={activeNodeMessages}
        onToggleMaximize={() => setIsGraphMaximized((prev) => !prev)}
        onClose={handleCloseGraph}
        onNodeClick={handleNodeClick}
        onClearActiveNode={() => setActiveNodeId(null)}
      />

      {isModalOpen && (
        <CreateNodeModal
          selectedMessages={selectedMessages}
          onConfirm={handleModalConfirm}
          onCancel={handleModalCancel}
        />
      )}
    </main>
  );
}

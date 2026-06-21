import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";
import type { SemanticEdge } from "@/src/types/edge";
import GraphToolbar from "./GraphToolbar";
import GraphCanvas from "./GraphCanvas";
import NodeDetailPanel from "./NodeDetailPanel";

type GraphDrawerProps = {
  isOpen: boolean;
  isMaximized: boolean;
  nodes: ContextNode[];
  semanticEdges: SemanticEdge[];
  activeNode: ContextNode | null;
  activeNodeMessages: ChatMessage[];
  onToggleMaximize: () => void;
  onClose: () => void;
  onNodeClick: (nodeId: string) => void;
  onClearActiveNode: () => void;
};

export default function GraphDrawer({
  isOpen,
  isMaximized,
  nodes,
  semanticEdges,
  activeNode,
  activeNodeMessages,
  onToggleMaximize,
  onClose,
  onNodeClick,
  onClearActiveNode,
}: GraphDrawerProps) {
  const isEmpty = nodes.length === 0;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      )}

      {/* Drawer */}
      <aside
        className={`fixed right-0 top-0 z-40 h-full transform border-l border-gray-200 bg-white shadow-2xl transition-all duration-300 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        } ${isMaximized ? "w-full" : "w-[460px]"}`}
      >
        <GraphToolbar
          isMaximized={isMaximized}
          onToggleMaximize={onToggleMaximize}
          onClose={onClose}
        />

        {/* Body — everything below the toolbar */}
        <div className="h-[calc(100%-4rem)]">
          {isEmpty ? (
            // Empty state
            <div className="flex h-full items-center justify-center bg-gray-50 text-center text-gray-500">
              <div>
                <div className="mb-3 text-4xl">●──●</div>
                <p className="font-medium">No nodes yet</p>
                <p className="mt-1 text-sm">
                  Select chat messages and create your first context node.
                </p>
              </div>
            </div>
          ) : isMaximized && activeNode ? (
            // Maximized + node selected: canvas left, detail panel right
            <div className="flex h-full">
              <div className="flex-1">
                <GraphCanvas contextNodes={nodes} semanticEdges={semanticEdges} onNodeClick={onNodeClick} />
              </div>
              <div className="w-80 shrink-0 border-l border-gray-200">
                <NodeDetailPanel
                  node={activeNode}
                  linkedMessages={activeNodeMessages}
                  onClose={onClearActiveNode}
                />
              </div>
            </div>
          ) : (
            // Drawer mode (or maximized with no node selected):
            // canvas on top, detail panel slides in below
            <div className="flex h-full flex-col">
              <div className={activeNode ? "h-[55%]" : "h-full"}>
                <GraphCanvas contextNodes={nodes} semanticEdges={semanticEdges} onNodeClick={onNodeClick} />
              </div>
              {activeNode && (
                <div className="h-[45%]">
                  <NodeDetailPanel
                    node={activeNode}
                    linkedMessages={activeNodeMessages}
                    onClose={onClearActiveNode}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

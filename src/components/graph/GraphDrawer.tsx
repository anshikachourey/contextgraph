import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";
import type { SemanticEdge } from "@/src/types/edge";
import type { EvolutionSuggestion } from "@/src/types/evolution";
import GraphToolbar from "./GraphToolbar";
import GraphCanvas from "./GraphCanvas";
import NodeDetailPanel from "./NodeDetailPanel";
import EdgeDetailPanel from "./EdgeDetailPanel";
import GraphSummaryPanel from "./GraphSummaryPanel";
import EvolutionPanel from "./EvolutionPanel";

type GraphDrawerProps = {
  isOpen: boolean;
  isMaximized: boolean;
  nodes: ContextNode[];
  semanticEdges: SemanticEdge[];
  hasMessages: boolean;
  activeNode: ContextNode | null;
  activeNodeMessages: ChatMessage[];
  activeEdge: SemanticEdge | null;
  // Graph summary
  graphSummary: string | null;
  isSummarizing: boolean;
  summaryError: string | null;
  onSummarize: () => void;
  onClearSummary: () => void;
  // Structure conversation
  isStructuring: boolean;
  onStructure: () => void;
  // Evolution
  isEvolving: boolean;
  evolutionSuggestions: EvolutionSuggestion[];
  onEvolve: () => void;
  onApplySuggestion: (s: EvolutionSuggestion) => void;
  onDismissSuggestion: (s: EvolutionSuggestion) => void;
  onCloseEvolution: () => void;
  // Branch
  onBranch: (nodeId: string) => void;
  // Actions
  onToggleMaximize: () => void;
  onClose: () => void;
  onNodeClick: (nodeId: string) => void;
  onEdgeClick: (edgeId: string) => void;
  onClearSelection: () => void;
};

export default function GraphDrawer({
  isOpen,
  isMaximized,
  nodes,
  semanticEdges,
  hasMessages,
  activeNode,
  activeNodeMessages,
  activeEdge,
  graphSummary,
  isSummarizing,
  summaryError,
  onSummarize,
  onClearSummary,
  isStructuring,
  onStructure,
  isEvolving,
  evolutionSuggestions,
  onEvolve,
  onApplySuggestion,
  onDismissSuggestion,
  onCloseEvolution,
  onBranch,
  onToggleMaximize,
  onClose,
  onNodeClick,
  onEdgeClick,
  onClearSelection,
}: GraphDrawerProps) {
  const isEmpty = nodes.length === 0;

  const showSummary = isSummarizing || graphSummary !== null || summaryError !== null;
  const showEvolution = isEvolving || evolutionSuggestions.length > 0;

  // Evolution panel takes priority when active
  const hasPanel = showEvolution || showSummary || activeNode !== null || activeEdge !== null;

  const edgeSourceTitle = activeEdge
    ? (nodes.find((n) => n.id === activeEdge.sourceNodeId)?.title ?? "Unknown")
    : "";
  const edgeTargetTitle = activeEdge
    ? (nodes.find((n) => n.id === activeEdge.targetNodeId)?.title ?? "Unknown")
    : "";

  function renderPanel() {
    if (showEvolution) {
      return (
        <EvolutionPanel
          suggestions={evolutionSuggestions}
          isLoading={isEvolving}
          onApply={onApplySuggestion}
          onDismiss={onDismissSuggestion}
          onClose={onCloseEvolution}
        />
      );
    }
    if (showSummary) {
      return (
        <GraphSummaryPanel
          summary={graphSummary}
          isLoading={isSummarizing}
          error={summaryError}
          onClose={onClearSummary}
        />
      );
    }
    if (activeNode) {
      return (
        <NodeDetailPanel
          node={activeNode}
          linkedMessages={activeNodeMessages}
          onClose={onClearSelection}
          onBranch={onBranch}
        />
      );
    }
    if (activeEdge) {
      return (
        <EdgeDetailPanel
          edge={activeEdge}
          sourceTitle={edgeSourceTitle}
          targetTitle={edgeTargetTitle}
          onClose={onClearSelection}
        />
      );
    }
    return null;
  }

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      )}

      <aside
        className={`fixed right-0 top-0 z-40 h-full transform border-l border-gray-200 bg-white shadow-2xl transition-all duration-300 ${
          isOpen ? "translate-x-0" : "translate-x-full"
        } ${isMaximized ? "w-full" : "w-[460px]"}`}
      >
        <GraphToolbar
          isMaximized={isMaximized}
          hasNodes={!isEmpty}
          hasMessages={hasMessages}
          isSummarizing={isSummarizing}
          isStructuring={isStructuring}
          isEvolving={isEvolving}
          onSummarize={onSummarize}
          onStructure={onStructure}
          onEvolve={onEvolve}
          onToggleMaximize={onToggleMaximize}
          onClose={onClose}
        />

        <div className="h-[calc(100%-4rem)]">
          {isEmpty ? (
            <div className="flex h-full items-center justify-center bg-gray-50 text-center text-gray-500">
              <div>
                <div className="mb-3 text-4xl">●──●</div>
                <p className="font-medium">No nodes yet</p>
                <p className="mt-1 text-sm">
                  Select chat messages and create your first context node.
                </p>
              </div>
            </div>
          ) : isMaximized && hasPanel ? (
            <div className="flex h-full">
              <div className="flex-1">
                <GraphCanvas
                  contextNodes={nodes}
                  semanticEdges={semanticEdges}
                  onNodeClick={onNodeClick}
                  onEdgeClick={onEdgeClick}
                />
              </div>
              <div className="w-80 shrink-0 border-l border-gray-200">
                {renderPanel()}
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className={hasPanel ? "h-[55%]" : "h-full"}>
                <GraphCanvas
                  contextNodes={nodes}
                  semanticEdges={semanticEdges}
                  onNodeClick={onNodeClick}
                  onEdgeClick={onEdgeClick}
                />
              </div>
              {hasPanel && (
                <div className="h-[45%]">{renderPanel()}</div>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

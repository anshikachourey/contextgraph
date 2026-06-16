import type { ContextNode } from "@/src/types/node";
import GraphToolbar from "./GraphToolbar";
import GraphCanvas from "./GraphCanvas";

type GraphDrawerProps = {
  isOpen: boolean;
  isMaximized: boolean;
  nodes: ContextNode[];
  onToggleMaximize: () => void;
  onClose: () => void;
};

export default function GraphDrawer({
  isOpen,
  isMaximized,
  nodes,
  onToggleMaximize,
  onClose,
}: GraphDrawerProps) {
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

        {/* Canvas area — takes all remaining height below toolbar */}
        <div className="h-[calc(100%-4rem)]">
          {nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center bg-gray-50 text-center text-gray-500">
              <div>
                <div className="mb-3 text-4xl">●──●</div>
                <p className="font-medium">No nodes yet</p>
                <p className="mt-1 text-sm">
                  Select chat messages and create your first context node.
                </p>
              </div>
            </div>
          ) : (
            <GraphCanvas contextNodes={nodes} />
          )}
        </div>
      </aside>
    </>
  );
}

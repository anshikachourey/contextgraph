type GraphToolbarProps = {
  isMaximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
};

export default function GraphToolbar({
  isMaximized,
  onToggleMaximize,
  onClose,
}: GraphToolbarProps) {
  return (
    <div className="flex h-16 items-center justify-between border-b border-gray-200 px-5">
      <h2 className="font-semibold">Context Graph</h2>

      <div className="flex items-center gap-2">
        <button
          onClick={onToggleMaximize}
          className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
        >
          {isMaximized ? "Exit full screen" : "Maximize"}
        </button>

        <button
          onClick={onClose}
          className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
        >
          Close
        </button>
      </div>
    </div>
  );
}

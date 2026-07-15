type HeaderProps = {
  onShowGraph: () => void;
  onShowV2Preview?: () => void;
};

const v2Enabled = process.env.NEXT_PUBLIC_V2_GRAPH_PREVIEW === "true";

export default function Header({ onShowGraph, onShowV2Preview }: HeaderProps) {
  return (
    <header className="fixed left-0 right-0 top-0 z-20 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div className="text-lg font-semibold">ContextGraph</div>

      <div className="flex items-center gap-2">
        {v2Enabled && onShowV2Preview && (
          <button
            onClick={onShowV2Preview}
            className="rounded-md border border-purple-300 bg-purple-50 px-3 py-2 text-sm font-medium text-purple-700 hover:bg-purple-100"
          >
            V2 Preview
          </button>
        )}
        <button
          onClick={onShowGraph}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Show Context Graph
        </button>
      </div>
    </header>
  );
}

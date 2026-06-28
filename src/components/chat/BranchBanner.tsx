type BranchBannerProps = {
  nodeTitle: string;
  onExit: () => void;
};

export default function BranchBanner({ nodeTitle, onExit }: BranchBannerProps) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-purple-200 bg-purple-50 px-4 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-purple-500">↳</span>
        <span className="text-purple-800">
          Branching from: <span className="font-medium">{nodeTitle}</span>
        </span>
      </div>
      <button
        onClick={onExit}
        className="rounded-md px-2 py-0.5 text-xs text-purple-600 hover:bg-purple-100"
        aria-label="Exit branch mode"
      >
        ✕
      </button>
    </div>
  );
}

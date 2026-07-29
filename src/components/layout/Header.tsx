type HeaderProps = {
  onShowGraph: () => void;
  onShowV2Preview?: () => void;
};

const v2Enabled = process.env.NEXT_PUBLIC_V2_GRAPH_PREVIEW === "true";

export default function Header({ onShowGraph, onShowV2Preview }: HeaderProps) {
  return (
    <header className="fixed left-[var(--sidebar-width)] right-0 top-0 z-20 flex h-[var(--header-height)] items-center justify-between border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-md px-6">
      <div className="flex items-center gap-3">
        <h1 className="text-[15px] font-medium text-[var(--muted-foreground)]">
          Conversation
        </h1>
      </div>

      <div className="flex items-center gap-2">
        {v2Enabled && onShowV2Preview && (
          <button
            onClick={onShowV2Preview}
            className="focus-ring flex items-center gap-2 rounded-lg bg-[var(--foreground)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--background)] transition-colors hover:opacity-90"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="3" />
              <circle cx="18" cy="18" r="3" />
              <circle cx="18" cy="6" r="3" />
              <path d="M6 9v6M9 6h6M15 18H9" />
            </svg>
            Knowledge Graph
          </button>
        )}
      </div>
    </header>
  );
}

type HeaderProps = {
  onShowGraph: () => void;
  onShowV2Preview?: () => void;
  workspace?: string | null;
  onLogout?: () => void;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
};

const v2Enabled = process.env.NEXT_PUBLIC_V2_GRAPH_PREVIEW === "true";

export default function Header({
  onShowGraph,
  onShowV2Preview,
  workspace,
  onLogout,
  sidebarOpen = true,
  onToggleSidebar,
}: HeaderProps) {
  return (
    <header
      className={`fixed right-0 top-0 z-20 flex h-[var(--header-height)] items-center justify-between border-b border-[var(--border)] bg-[var(--surface)]/80 backdrop-blur-md px-4 transition-[left] duration-200 ease-in-out ${
        sidebarOpen ? "left-[var(--sidebar-width)] md:left-[var(--sidebar-width)]" : "left-0"
      }`}
    >
      <div className="flex items-center gap-2">
        {/* Sidebar toggle */}
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
            title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            {sidebarOpen ? (
              /* Chevron left — collapse */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
                <path d="M14 9l-3 3 3 3" />
              </svg>
            ) : (
              /* Menu / expand */
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
                <path d="M12 9l3 3-3 3" />
              </svg>
            )}
          </button>
        )}

        <h1 className="text-[15px] font-medium text-[var(--muted-foreground)]">
          Conversation
        </h1>
        {workspace && (
          <span className="ml-1 rounded bg-[var(--surface-raised)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted-foreground)] uppercase tracking-wide">
            {workspace}
          </span>
        )}
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
        {onLogout && (
          <button
            onClick={onLogout}
            className="focus-ring rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--surface-raised)] hover:text-[var(--foreground)]"
          >
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}

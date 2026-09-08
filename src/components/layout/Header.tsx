import { TopNav } from "@astryxdesign/core/TopNav";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Button } from "@astryxdesign/core/Button";
import { Badge } from "@astryxdesign/core/Badge";

type HeaderProps = {
  onShowGraph: () => void;
  onShowV2Preview?: () => void;
  workspace?: string | null;
  onLogout?: () => void;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
};

const v2Enabled = process.env.NEXT_PUBLIC_V2_GRAPH_PREVIEW === "true";

/** Small graph glyph used for the Knowledge Graph control. */
function GraphGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M6 9v6M9 6h6M15 18H9" />
    </svg>
  );
}

/** Sidebar collapse/expand glyph. */
function SidebarGlyph({ open }: { open: boolean }) {
  return open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M14 9l-3 3 3 3" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="M12 9l3 3-3 3" />
    </svg>
  );
}

export default function Header({
  onShowGraph,
  onShowV2Preview,
  workspace,
  onLogout,
  sidebarOpen = true,
  onToggleSidebar,
}: HeaderProps) {
  return (
    <TopNav
      label="Application"
      heading={
        <div className="flex items-center gap-2">
          {onToggleSidebar && (
            <IconButton
              variant="ghost"
              size="sm"
              label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              tooltip={sidebarOpen ? "Close sidebar" : "Open sidebar"}
              icon={<SidebarGlyph open={sidebarOpen} />}
              onClick={onToggleSidebar}
            />
          )}
          <span className="text-[15px] font-medium text-[var(--muted-foreground)]">
            Conversation
          </span>
          {workspace && <Badge variant="neutral" label={workspace} />}
        </div>
      }
      endContent={
        <div className="flex items-center gap-2">
          {v2Enabled && onShowV2Preview && (
            <Button
              variant="primary"
              size="sm"
              label="Knowledge Graph"
              icon={<GraphGlyph />}
              onClick={onShowV2Preview}
            />
          )}
          {onLogout && (
            <Button variant="ghost" size="sm" label="Sign out" onClick={onLogout} />
          )}
        </div>
      }
    />
  );
}

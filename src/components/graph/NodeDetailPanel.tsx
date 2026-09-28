import { IconButton } from "@astryxdesign/core/IconButton";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import type { ContextNode } from "@/src/types/node";
import type { ChatMessage } from "@/src/types/message";

type NodeDetailPanelProps = {
  node: ContextNode;
  linkedMessages: ChatMessage[];
  onClose: () => void;
  onBranch: (nodeId: string) => void;
};

export default function NodeDetailPanel({
  node,
  linkedMessages,
  onClose,
  onBranch,
}: NodeDetailPanelProps) {
  return (
    <div className="flex h-full flex-col border-t border-[var(--border)] bg-[var(--surface)]">
      {/* Panel header */}
      <div className="flex items-start justify-between px-5 pt-4 pb-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Node
          </p>
          <h3 className="mt-0.5 text-[16px] font-semibold leading-snug text-[var(--foreground)]">
            {node.title}
          </h3>
        </div>
        <IconButton
          variant="ghost"
          size="sm"
          label="Close node detail"
          icon={<Icon icon="close" />}
          onClick={onClose}
        />
      </div>

      {/* Summary */}
      <p className="px-5 text-[14px] text-[var(--muted-foreground)]">{node.summary}</p>

      {/* Branch action */}
      <div className="px-5 pt-3">
        <Button
          variant="secondary"
          size="sm"
          label="↳ Continue from this node"
          onClick={() => onBranch(node.id)}
        />
      </div>

      {/* Linked messages */}
      <div className="mt-4 flex-1 overflow-y-auto px-5 pb-5">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {linkedMessages.length} linked message
          {linkedMessages.length === 1 ? "" : "s"}
        </p>

        <div className="space-y-2">
          {linkedMessages.map((message) => (
            <div
              key={message.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--muted)] px-3 py-2"
            >
              <p className="mb-1 text-[11px] font-semibold text-[var(--muted-foreground)]">
                {message.role === "user" ? "You" : "Assistant"}
              </p>
              <p className="line-clamp-3 text-[14px] text-[var(--foreground)]">
                {message.content}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type HeaderProps = {
  onShowGraph: () => void;
};

export default function Header({ onShowGraph }: HeaderProps) {
  return (
    <header className="fixed left-0 right-0 top-0 z-20 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div className="text-lg font-semibold">ContextGraph</div>

      <button
        onClick={onShowGraph}
        className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
      >
        Show Context Graph
      </button>
    </header>
  );
}

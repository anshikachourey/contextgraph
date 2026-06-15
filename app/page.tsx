"use client";

import { useState } from "react";

export default function Home() {
  const [isGraphOpen, setIsGraphOpen] = useState(false);
  const [isGraphMaximized, setIsGraphMaximized] = useState(false);

  return (
    <main className="relative min-h-screen bg-white text-black">
      {/* Top bar */}
      <header className="fixed left-0 right-0 top-0 z-20 flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
        <div className="text-lg font-semibold">ContextGraph</div>

        <button
          onClick={() => setIsGraphOpen(true)}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
        >
          Show Context Graph
        </button>
      </header>

      {/* Chat area */}
      <section className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end px-6 pb-10 pt-24">
        <div className="mb-8 space-y-5">
          <div className="rounded-2xl bg-gray-100 p-4">
            <p className="text-sm font-semibold text-gray-600">You</p>
            <p className="mt-1">Help me plan my AI startup.</p>
          </div>

          <div className="rounded-2xl bg-blue-50 p-4">
            <p className="text-sm font-semibold text-gray-600">Assistant</p>
            <p className="mt-1">
              Let&apos;s start by identifying the core user problem, target
              audience, and first MVP loop.
            </p>
          </div>
        </div>

        <div className="flex items-center rounded-2xl border border-gray-300 bg-white p-3 shadow-sm">
          <input
            className="flex-1 outline-none"
            placeholder="Ask ContextGraph..."
          />
          <button className="rounded-xl bg-black px-4 py-2 text-sm text-white">
            Send
          </button>
        </div>
      </section>

      {/* Overlay */}
      {isGraphOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/20"
          onClick={() => setIsGraphOpen(false)}
        />
      )}

      {/* Graph drawer */}
      <aside
        className={`fixed right-0 top-0 z-40 h-full transform border-l border-gray-200 bg-white shadow-2xl transition-all duration-300 ${
          isGraphOpen
            ? "translate-x-0"
            : "translate-x-full"
        } ${isGraphMaximized ? "w-full" : "w-[460px]"}`}
      >
        <div className="flex h-16 items-center justify-between border-b border-gray-200 px-5">
          <h2 className="font-semibold">Context Graph</h2>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsGraphMaximized(!isGraphMaximized)}
              className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
            >
              {isGraphMaximized ? "Exit full screen" : "Maximize"}
            </button>

            <button
              onClick={() => {
                setIsGraphOpen(false);
                setIsGraphMaximized(false);
              }}
              className="rounded-md px-3 py-1 text-sm hover:bg-gray-100"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex h-[calc(100%-4rem)] items-center justify-center bg-gray-50">
          <div className="text-center text-gray-500">
            <div className="mb-3 text-4xl">●──●</div>
            <p className="font-medium">Graph coming soon</p>
            <p className="mt-1 text-sm">
              Nodes will appear here as topics are created.
            </p>
          </div>
        </div>
      </aside>
    </main>
  );
}
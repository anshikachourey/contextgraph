/**
 * Intelligence engine logger.
 *
 * Verbose debug logs are gated behind DEBUG_GRAPH_PIPELINE env var.
 * Production-safe logs (errors, materialization events) always emit.
 */

const isDebug = process.env.DEBUG_GRAPH_PIPELINE === "true";

/** Verbose debug log — only in dev/debug mode */
export function debugLog(message: string, data?: unknown): void {
  if (!isDebug) return;
  if (data !== undefined) {
    console.log(message, typeof data === "string" ? data : JSON.stringify(data));
  } else {
    console.log(message);
  }
}

/** Production-safe info log — always emits, kept concise */
export function infoLog(message: string, data?: Record<string, unknown>): void {
  if (data) {
    console.log(message, JSON.stringify(data));
  } else {
    console.log(message);
  }
}

/** Error log — always emits */
export function errorLog(message: string, err?: unknown): void {
  console.error(message, err);
}

/** Emit the full pipeline log JSON — only in debug mode */
export function emitPipelineLog(log: unknown): void {
  if (isDebug) {
    console.log(`\n=== Graph Pipeline ===\n${JSON.stringify(log, null, 2)}`);
  }
}

/**
 * Authority State Machine — manages SIE/V2 authority transitions.
 *
 * The transition model enforces:
 * - Exactly one production semantic writer per conversation at any time.
 * - SIE_SHADOW mode isolates SIE output from production state.
 * - V2 → SIE must go through SIE_SHADOW (no direct cutover).
 * - SIE → V2 must go through SIE_SHADOW (no direct rollback to V2).
 *
 * Valid transitions:
 *   V2 → SIE_SHADOW       (enable shadow mode)
 *   SIE_SHADOW → SIE      (cutover to SIE authority)
 *   SIE → SIE_SHADOW      (rollback to shadow)
 *   SIE_SHADOW → V2       (disable shadow)
 *
 * Invalid transitions:
 *   V2 → SIE              (must go through shadow first)
 *   SIE → V2              (must go through shadow first)
 *   Any state → same state (no-op transitions are not valid)
 */

// ─── Authority State Type ───────────────────────────────────────────────────

/**
 * The three authority states a conversation can be in.
 *
 * - `V2`: Legacy V2 engine is authoritative. SIE does not participate.
 * - `SIE_SHADOW`: V2 remains authoritative for production. SIE may analyze
 *   messages and write to isolated shadow storage, but must NOT alter the
 *   production snapshot, cursor, or mutation history.
 * - `SIE`: SIE is authoritative. The legacy Thread → Object identity path
 *   must NOT write authoritative objects. V2 snapshot becomes a
 *   backward-compatible projection.
 */
export type AuthorityState = "V2" | "SIE_SHADOW" | "SIE";

// ─── Engine Type ────────────────────────────────────────────────────────────

/** The two semantic engines that can attempt writes. */
export type Engine = "v2" | "sie";

// ─── Valid Transition Map ───────────────────────────────────────────────────

/**
 * Adjacency set defining all valid authority-state transitions.
 * A transition is valid only if the (from, to) pair appears here.
 */
const VALID_TRANSITIONS: ReadonlyMap<AuthorityState, ReadonlySet<AuthorityState>> =
  new Map([
    ["V2", new Set<AuthorityState>(["SIE_SHADOW"])],
    ["SIE_SHADOW", new Set<AuthorityState>(["V2", "SIE"])],
    ["SIE", new Set<AuthorityState>(["SIE_SHADOW"])],
  ]);

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validates whether a state transition is allowed.
 *
 * Rules:
 * - V2 → SIE_SHADOW: allowed (enable shadow)
 * - SIE_SHADOW → SIE: allowed (cutover)
 * - SIE → SIE_SHADOW: allowed (rollback)
 * - SIE_SHADOW → V2: allowed (disable shadow)
 * - V2 → SIE: NOT allowed (must go through shadow)
 * - SIE → V2: NOT allowed (must go through shadow)
 * - Same-state transitions: NOT allowed
 */
export function validateTransition(
  from: AuthorityState,
  to: AuthorityState
): boolean {
  if (from === to) return false;
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed !== undefined && allowed.has(to);
}

/**
 * Determines whether a given engine is the production semantic writer
 * in the specified authority state.
 *
 * Exactly one engine writes production state at any time:
 * - V2 state: v2 engine is the production writer
 * - SIE_SHADOW state: v2 engine is the production writer (SIE is shadow-only)
 * - SIE state: sie engine is the production writer
 */
export function isProductionWriter(
  state: AuthorityState,
  engine: Engine
): boolean {
  switch (state) {
    case "V2":
      return engine === "v2";
    case "SIE_SHADOW":
      // In shadow mode, V2 remains the sole production writer.
      // SIE writes only to isolated shadow storage.
      return engine === "v2";
    case "SIE":
      return engine === "sie";
  }
}

/**
 * Determines whether a given engine can write to the production snapshot
 * in the specified authority state.
 *
 * - V2: only v2 can write production snapshot
 * - SIE_SHADOW: only v2 can write production snapshot;
 *   SIE output is isolated from production snapshot
 * - SIE: only sie can write production snapshot
 */
export function canWriteProductionSnapshot(
  state: AuthorityState,
  engine: Engine
): boolean {
  switch (state) {
    case "V2":
      return engine === "v2";
    case "SIE_SHADOW":
      // SIE output must be isolated from production snapshot
      return engine === "v2";
    case "SIE":
      return engine === "sie";
  }
}

/**
 * Determines whether a given engine can advance the production cursor
 * in the specified authority state.
 *
 * - V2: only v2 can advance cursor
 * - SIE_SHADOW: only v2 can advance cursor;
 *   SIE output is isolated from production cursor
 * - SIE: only sie can advance cursor
 */
export function canWriteProductionCursor(
  state: AuthorityState,
  engine: Engine
): boolean {
  switch (state) {
    case "V2":
      return engine === "v2";
    case "SIE_SHADOW":
      // SIE output must be isolated from production cursor
      return engine === "v2";
    case "SIE":
      return engine === "sie";
  }
}

/**
 * Determines whether the current authority state is shadow mode.
 *
 * In shadow mode:
 * - V2 remains the production writer
 * - SIE may analyze messages for evaluation purposes
 * - SIE output is written to isolated shadow storage ONLY
 * - SIE must NOT alter production snapshot, cursor, or mutation history
 */
export function isShadowMode(state: AuthorityState): boolean {
  return state === "SIE_SHADOW";
}

/**
 * In SIE authority state, the legacy Thread → Object identity path must NOT
 * write authoritative objects. This function checks whether a legacy V2
 * thread-to-object write should be blocked.
 *
 * Returns true if the write must be blocked (SIE is authoritative and the
 * engine attempting is v2 via the thread→object path).
 */
export function isLegacyThreadObjectWriteBlocked(
  state: AuthorityState
): boolean {
  return state === "SIE";
}

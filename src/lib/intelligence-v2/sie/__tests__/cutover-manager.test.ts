/**
 * Cutover Manager Tests — Mandatory authority-transition tests.
 *
 * Covers:
 * 1. Shadow isolation: SIE cannot alter production state in shadow mode.
 * 2. Dual production writer rejection: both engines cannot be production writers simultaneously.
 * 3. Cutover guards: requires SIE_SHADOW state, valid graph version, feature flag.
 * 4. Rollback guards: requires SIE state, valid graph version.
 * 5. V2 caller compatibility: existing V2 callers remain functional while authority is V2.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canWriteProductionSnapshot,
  canWriteProductionCursor,
  isProductionWriter,
  type AuthorityState,
  type Engine,
} from "../authority-state-machine";

// ─── Mocks ──────────────────────────────────────────────────────────────────

/**
 * Tracks which tables are accessed and stores mock responses.
 * The cutover-manager accesses:
 *   - v2_update_state: select().eq().single() for reading, update().eq().eq() for writing
 *   - sie_audit_history: insert() for audit trail
 */
let mockSelectResult: { data: unknown; error: unknown };
let mockUpdateResult: { data: unknown; error: unknown };
let mockInsertResult: { data: unknown; error: unknown };
let tableAccesses: string[];

vi.mock("@/src/lib/supabase/server", () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      tableAccesses.push(table);
      return {
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve(mockSelectResult),
          }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve(mockUpdateResult),
          }),
        }),
        insert: () => Promise.resolve(mockInsertResult),
      };
    },
  }),
}));

// Feature flag mock — controlled per-test
let mockAuthorityEnabled = false;
vi.mock("../feature-flags", () => ({
  get SIE_AUTHORITY_ENABLED() {
    return mockAuthorityEnabled;
  },
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { requestCutover, requestRollback } from "../cutover-manager";

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorityEnabled = false;
  mockSelectResult = { data: null, error: null };
  mockUpdateResult = { data: null, error: null };
  mockInsertResult = { data: null, error: null };
  tableAccesses = [];
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Shadow Isolation Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Shadow isolation — SIE cannot alter production state", () => {
  it("shadow mode blocks SIE from writing production snapshot", () => {
    expect(canWriteProductionSnapshot("SIE_SHADOW", "sie")).toBe(false);
  });

  it("shadow mode blocks SIE from advancing production cursor", () => {
    expect(canWriteProductionCursor("SIE_SHADOW", "sie")).toBe(false);
  });

  it("SIE is not the production writer in shadow mode", () => {
    expect(isProductionWriter("SIE_SHADOW", "sie")).toBe(false);
  });

  it("V2 remains the sole production writer in shadow mode", () => {
    expect(isProductionWriter("SIE_SHADOW", "v2")).toBe(true);
    expect(canWriteProductionSnapshot("SIE_SHADOW", "v2")).toBe(true);
    expect(canWriteProductionCursor("SIE_SHADOW", "v2")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Dual Production Writer Rejection
// ═══════════════════════════════════════════════════════════════════════════════

describe("Dual production writer rejection", () => {
  it("cannot have both V2 and SIE as production writers simultaneously", () => {
    const states: AuthorityState[] = ["V2", "SIE_SHADOW", "SIE"];
    const engines: Engine[] = ["v2", "sie"];

    for (const state of states) {
      const productionWriters = engines.filter((e) =>
        isProductionWriter(state, e)
      );
      // Exactly one writer per state — never two
      expect(productionWriters).toHaveLength(1);
    }
  });

  it("in V2 state, only v2 is the production writer", () => {
    expect(isProductionWriter("V2", "v2")).toBe(true);
    expect(isProductionWriter("V2", "sie")).toBe(false);
  });

  it("in SIE state, only sie is the production writer", () => {
    expect(isProductionWriter("SIE", "sie")).toBe(true);
    expect(isProductionWriter("SIE", "v2")).toBe(false);
  });

  it("in SIE_SHADOW state, only v2 is the production writer", () => {
    expect(isProductionWriter("SIE_SHADOW", "v2")).toBe(true);
    expect(isProductionWriter("SIE_SHADOW", "sie")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Cutover Tests (mocked DB)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cutover operations (mocked DB)", () => {
  const conversationId = "conv-cutover-test";

  describe("cutover requires SIE_SHADOW state", () => {
    it("rejects cutover when in V2 state (V2 → SIE direct is invalid)", async () => {
      mockAuthorityEnabled = true;

      // Simulate DB returning V2 state
      mockSelectResult = {
        data: { authoritative_engine: "V2", update_version: 10 },
        error: null,
      };

      const result = await requestCutover(conversationId, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("V2");
      expect(result.error).toContain("expected SIE_SHADOW");
    });

    it("rejects cutover when already in SIE state", async () => {
      mockAuthorityEnabled = true;

      mockSelectResult = {
        data: { authoritative_engine: "SIE", update_version: 10 },
        error: null,
      };

      const result = await requestCutover(conversationId, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("SIE");
      expect(result.error).toContain("expected SIE_SHADOW");
    });
  });

  describe("cutover requires valid graph version", () => {
    it("rejects cutover when version mismatch occurs", async () => {
      mockAuthorityEnabled = true;

      // DB has version 12, but caller expects version 10
      mockSelectResult = {
        data: { authoritative_engine: "SIE_SHADOW", update_version: 12 },
        error: null,
      };

      const result = await requestCutover(conversationId, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Version mismatch");
      expect(result.error).toContain("expected 10");
      expect(result.error).toContain("actual 12");
    });
  });

  describe("cutover requires SIE_AUTHORITY_ENABLED flag", () => {
    it("rejects cutover when feature flag is disabled", async () => {
      mockAuthorityEnabled = false;

      const result = await requestCutover(conversationId, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("SIE authority is not enabled");
    });
  });

  describe("successful cutover", () => {
    it("transitions to SIE state and produces audit record", async () => {
      mockAuthorityEnabled = true;

      // DB reports SIE_SHADOW at version 10
      mockSelectResult = {
        data: { authoritative_engine: "SIE_SHADOW", update_version: 10 },
        error: null,
      };

      // Update and insert both succeed (already defaults)
      mockUpdateResult = { data: null, error: null };
      mockInsertResult = { data: null, error: null };

      const result = await requestCutover(conversationId, 10);

      expect(result.success).toBe(true);
      expect(result.newAuthority).toBe("SIE");
      expect(result.graphVersion).toBe(10);

      // Verify that from() was called for both v2_update_state and sie_audit_history
      expect(tableAccesses).toContain("v2_update_state");
      expect(tableAccesses).toContain("sie_audit_history");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Rollback Tests (mocked DB)
// ═══════════════════════════════════════════════════════════════════════════════

describe("Rollback operations (mocked DB)", () => {
  const conversationId = "conv-rollback-test";

  describe("rollback requires SIE state", () => {
    it("rejects rollback when in SIE_SHADOW state (SIE_SHADOW → SIE_SHADOW is invalid)", async () => {
      mockSelectResult = {
        data: { authoritative_engine: "SIE_SHADOW", update_version: 10 },
        error: null,
      };

      const result = await requestRollback(conversationId, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("SIE_SHADOW");
      expect(result.error).toContain("expected SIE");
    });

    it("rejects rollback when in V2 state", async () => {
      mockSelectResult = {
        data: { authoritative_engine: "V2", update_version: 10 },
        error: null,
      };

      const result = await requestRollback(conversationId, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("V2");
      expect(result.error).toContain("expected SIE");
    });
  });

  describe("rollback requires valid graph version", () => {
    it("rejects rollback when version mismatch occurs", async () => {
      // DB has version 15, caller expects 10
      mockSelectResult = {
        data: { authoritative_engine: "SIE", update_version: 15 },
        error: null,
      };

      const result = await requestRollback(conversationId, 10);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Version mismatch");
      expect(result.error).toContain("expected 10");
      expect(result.error).toContain("actual 15");
    });
  });

  describe("successful rollback", () => {
    it("transitions to SIE_SHADOW state and produces audit record", async () => {
      // DB reports SIE at version 10
      mockSelectResult = {
        data: { authoritative_engine: "SIE", update_version: 10 },
        error: null,
      };

      // Update and insert succeed (defaults)
      mockUpdateResult = { data: null, error: null };
      mockInsertResult = { data: null, error: null };

      const result = await requestRollback(conversationId, 10);

      expect(result.success).toBe(true);
      expect(result.newAuthority).toBe("SIE_SHADOW");
      expect(result.graphVersion).toBe(10);

      // Verify audit trail was written
      expect(tableAccesses).toContain("sie_audit_history");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. V2 Caller Compatibility
// ═══════════════════════════════════════════════════════════════════════════════

describe("V2 caller compatibility — existing callers remain functional while authority is V2", () => {
  it("while authority is V2, existing callers remain functional", () => {
    // V2 is the production writer — this means existing V2 code paths work
    expect(isProductionWriter("V2", "v2")).toBe(true);
  });

  it("V2 engine can write production snapshot in V2 state", () => {
    expect(canWriteProductionSnapshot("V2", "v2")).toBe(true);
  });

  it("V2 engine can advance cursor in V2 state", () => {
    expect(canWriteProductionCursor("V2", "v2")).toBe(true);
  });

  it("SIE engine is rejected from production writes in V2 state", () => {
    expect(canWriteProductionSnapshot("V2", "sie")).toBe(false);
    expect(canWriteProductionCursor("V2", "sie")).toBe(false);
    expect(isProductionWriter("V2", "sie")).toBe(false);
  });
});

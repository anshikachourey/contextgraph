import { describe, it, expect } from "vitest";
import {
  type AuthorityState,
  type Engine,
  validateTransition,
  isProductionWriter,
  canWriteProductionSnapshot,
  canWriteProductionCursor,
  isShadowMode,
  isLegacyThreadObjectWriteBlocked,
} from "../authority-state-machine";

describe("Authority State Machine", () => {
  describe("validateTransition", () => {
    it("allows V2 → SIE_SHADOW (enable shadow mode)", () => {
      expect(validateTransition("V2", "SIE_SHADOW")).toBe(true);
    });

    it("allows SIE_SHADOW → SIE (cutover to SIE authority)", () => {
      expect(validateTransition("SIE_SHADOW", "SIE")).toBe(true);
    });

    it("allows SIE → SIE_SHADOW (rollback to shadow)", () => {
      expect(validateTransition("SIE", "SIE_SHADOW")).toBe(true);
    });

    it("allows SIE_SHADOW → V2 (disable shadow)", () => {
      expect(validateTransition("SIE_SHADOW", "V2")).toBe(true);
    });

    it("rejects V2 → SIE (must go through shadow first)", () => {
      expect(validateTransition("V2", "SIE")).toBe(false);
    });

    it("rejects SIE → V2 (must go through shadow first)", () => {
      expect(validateTransition("SIE", "V2")).toBe(false);
    });

    it("rejects same-state transitions", () => {
      const states: AuthorityState[] = ["V2", "SIE_SHADOW", "SIE"];
      for (const state of states) {
        expect(validateTransition(state, state)).toBe(false);
      }
    });
  });

  describe("isProductionWriter — single writer enforcement", () => {
    it("V2 state: v2 engine is the production writer", () => {
      expect(isProductionWriter("V2", "v2")).toBe(true);
      expect(isProductionWriter("V2", "sie")).toBe(false);
    });

    it("SIE_SHADOW state: v2 engine is still the production writer", () => {
      expect(isProductionWriter("SIE_SHADOW", "v2")).toBe(true);
      expect(isProductionWriter("SIE_SHADOW", "sie")).toBe(false);
    });

    it("SIE state: sie engine is the production writer", () => {
      expect(isProductionWriter("SIE", "sie")).toBe(true);
      expect(isProductionWriter("SIE", "v2")).toBe(false);
    });

    it("exactly one production writer per state", () => {
      const states: AuthorityState[] = ["V2", "SIE_SHADOW", "SIE"];
      const engines: Engine[] = ["v2", "sie"];

      for (const state of states) {
        const writers = engines.filter((e) => isProductionWriter(state, e));
        expect(writers).toHaveLength(1);
      }
    });
  });

  describe("canWriteProductionSnapshot", () => {
    it("V2: only v2 can write production snapshot", () => {
      expect(canWriteProductionSnapshot("V2", "v2")).toBe(true);
      expect(canWriteProductionSnapshot("V2", "sie")).toBe(false);
    });

    it("SIE_SHADOW: SIE output is isolated from production snapshot", () => {
      expect(canWriteProductionSnapshot("SIE_SHADOW", "v2")).toBe(true);
      expect(canWriteProductionSnapshot("SIE_SHADOW", "sie")).toBe(false);
    });

    it("SIE: only sie can write production snapshot", () => {
      expect(canWriteProductionSnapshot("SIE", "sie")).toBe(true);
      expect(canWriteProductionSnapshot("SIE", "v2")).toBe(false);
    });
  });

  describe("canWriteProductionCursor", () => {
    it("V2: only v2 can advance cursor", () => {
      expect(canWriteProductionCursor("V2", "v2")).toBe(true);
      expect(canWriteProductionCursor("V2", "sie")).toBe(false);
    });

    it("SIE_SHADOW: SIE output is isolated from production cursor", () => {
      expect(canWriteProductionCursor("SIE_SHADOW", "v2")).toBe(true);
      expect(canWriteProductionCursor("SIE_SHADOW", "sie")).toBe(false);
    });

    it("SIE: only sie can advance cursor", () => {
      expect(canWriteProductionCursor("SIE", "sie")).toBe(true);
      expect(canWriteProductionCursor("SIE", "v2")).toBe(false);
    });
  });

  describe("isShadowMode", () => {
    it("returns true only for SIE_SHADOW", () => {
      expect(isShadowMode("SIE_SHADOW")).toBe(true);
      expect(isShadowMode("V2")).toBe(false);
      expect(isShadowMode("SIE")).toBe(false);
    });
  });

  describe("isLegacyThreadObjectWriteBlocked", () => {
    it("blocks legacy thread→object writes in SIE state", () => {
      expect(isLegacyThreadObjectWriteBlocked("SIE")).toBe(true);
    });

    it("allows legacy thread→object writes in V2 state", () => {
      expect(isLegacyThreadObjectWriteBlocked("V2")).toBe(false);
    });

    it("allows legacy thread→object writes in SIE_SHADOW state", () => {
      expect(isLegacyThreadObjectWriteBlocked("SIE_SHADOW")).toBe(false);
    });
  });

  describe("shadow isolation guarantees", () => {
    it("SIE engine cannot write production snapshot in shadow mode", () => {
      expect(canWriteProductionSnapshot("SIE_SHADOW", "sie")).toBe(false);
    });

    it("SIE engine cannot advance production cursor in shadow mode", () => {
      expect(canWriteProductionCursor("SIE_SHADOW", "sie")).toBe(false);
    });

    it("SIE engine is not the production writer in shadow mode", () => {
      expect(isProductionWriter("SIE_SHADOW", "sie")).toBe(false);
    });
  });

  describe("SIE authority constraints", () => {
    it("v2 engine cannot write production snapshot in SIE state", () => {
      expect(canWriteProductionSnapshot("SIE", "v2")).toBe(false);
    });

    it("v2 engine cannot advance production cursor in SIE state", () => {
      expect(canWriteProductionCursor("SIE", "v2")).toBe(false);
    });

    it("legacy thread→object path is blocked in SIE state", () => {
      expect(isLegacyThreadObjectWriteBlocked("SIE")).toBe(true);
    });
  });
});

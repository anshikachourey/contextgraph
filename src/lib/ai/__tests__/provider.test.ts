/**
 * Unit tests for provider.ts maxTokens validation and defaults.
 */
import { describe, it, expect } from "vitest";
import { validateMaxTokens, MaxTokensValidationError } from "../provider";

describe("validateMaxTokens", () => {
  // ─── Valid values ──────────────────────────────────────────────────────────

  it("accepts minimum valid value (1)", () => {
    expect(validateMaxTokens(1)).toBe(1);
  });

  it("accepts maximum valid value (16384)", () => {
    expect(validateMaxTokens(16384)).toBe(16384);
  });

  it("accepts a typical value (4096)", () => {
    expect(validateMaxTokens(4096)).toBe(4096);
  });

  it("accepts boundary value just above minimum (2)", () => {
    expect(validateMaxTokens(2)).toBe(2);
  });

  it("accepts boundary value just below maximum (16383)", () => {
    expect(validateMaxTokens(16383)).toBe(16383);
  });

  // ─── Invalid: out of range ─────────────────────────────────────────────────

  it("rejects zero", () => {
    expect(() => validateMaxTokens(0)).toThrow(MaxTokensValidationError);
  });

  it("rejects negative integers", () => {
    expect(() => validateMaxTokens(-1)).toThrow(MaxTokensValidationError);
  });

  it("rejects values above maximum (16385)", () => {
    expect(() => validateMaxTokens(16385)).toThrow(MaxTokensValidationError);
  });

  // ─── Invalid: non-integer numbers ─────────────────────────────────────────

  it("rejects floating point numbers", () => {
    expect(() => validateMaxTokens(4096.5)).toThrow(MaxTokensValidationError);
  });

  it("rejects NaN", () => {
    expect(() => validateMaxTokens(NaN)).toThrow(MaxTokensValidationError);
  });

  it("rejects Infinity", () => {
    expect(() => validateMaxTokens(Infinity)).toThrow(MaxTokensValidationError);
  });

  // ─── Invalid: non-number types ─────────────────────────────────────────────

  it("rejects strings", () => {
    expect(() => validateMaxTokens("4096")).toThrow(MaxTokensValidationError);
  });

  it("rejects null", () => {
    expect(() => validateMaxTokens(null)).toThrow(MaxTokensValidationError);
  });

  it("rejects undefined", () => {
    expect(() => validateMaxTokens(undefined)).toThrow(MaxTokensValidationError);
  });

  it("rejects objects", () => {
    expect(() => validateMaxTokens({})).toThrow(MaxTokensValidationError);
  });

  it("rejects arrays", () => {
    expect(() => validateMaxTokens([4096])).toThrow(MaxTokensValidationError);
  });

  it("rejects boolean", () => {
    expect(() => validateMaxTokens(true)).toThrow(MaxTokensValidationError);
  });

  // ─── Error message quality ─────────────────────────────────────────────────

  it("includes the allowed range in error message for out-of-range values", () => {
    try {
      validateMaxTokens(99999);
    } catch (e) {
      expect(e).toBeInstanceOf(MaxTokensValidationError);
      expect((e as MaxTokensValidationError).message).toContain("1");
      expect((e as MaxTokensValidationError).message).toContain("16384");
    }
  });

  it("includes the received value in error message for non-integer", () => {
    try {
      validateMaxTokens("hello");
    } catch (e) {
      expect(e).toBeInstanceOf(MaxTokensValidationError);
      expect((e as MaxTokensValidationError).message).toContain("hello");
    }
  });
});

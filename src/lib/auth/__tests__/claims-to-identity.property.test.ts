// Feature: google-oauth-authentication, Property 1: Claims resolve to the canonical Supabase user id or unauthenticated
//
// Validates: Requirements 4.1, 4.2, 4.4
//
// `getAuthClaims(client)` resolves identity ONLY from Supabase verified claims.
// For any claims object, it must return exactly `{ userId: claims.sub, email }`
// when a `sub` is present, or `null` otherwise — and it must NEVER surface a
// provider/Google subject as the canonical identity even when such a field is
// present alongside `sub`.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { getAuthClaims } from "../session";

/** A stub Supabase client whose getClaims() returns the supplied shape. */
function clientReturning(claims: Record<string, unknown> | null, error?: unknown) {
  return {
    auth: {
      getClaims: async () => ({
        data: claims === null ? null : { claims },
        error,
      }),
    },
  };
}

describe("Property 1: claims resolve to the canonical Supabase user id or null", () => {
  it("returns claims.sub (never a provider subject) when sub is present", () => {
    fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1 }), // sub (Supabase_User_Id)
        fc.option(fc.emailAddress(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }), // google provider subject
        fc.option(fc.string(), { nil: undefined }), // provider_id noise
        async (sub, email, googleSub, providerId) => {
          const claims: Record<string, unknown> = { sub };
          if (email !== undefined) claims.email = email;
          // Add decoy provider-subject fields that must NEVER be returned.
          if (googleSub !== undefined) claims.provider_sub = googleSub;
          if (providerId !== undefined) claims.sub_google = providerId;

          const result = await getAuthClaims(clientReturning(claims) as any);

          expect(result).not.toBeNull();
          expect(result!.userId).toBe(sub);
          // The identity is strictly claims.sub, never a provider field.
          expect(result!.userId).not.toBe(googleSub);
          expect(result!.userId).not.toBe(providerId);
          expect(result!.email).toBe(email);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("returns null when there is no sub, no claims, or an error", () => {
    fc.assert(
      fc.asyncProperty(
        fc.oneof(
          // claims object with no sub
          fc.record({
            email: fc.option(fc.emailAddress(), { nil: undefined }),
            provider_sub: fc.option(fc.string(), { nil: undefined }),
          }),
          // null data
          fc.constant(null),
        ),
        fc.boolean(), // simulate an error from getClaims()
        async (claims, withError) => {
          const result = await getAuthClaims(
            clientReturning(claims as any, withError ? new Error("x") : undefined) as any,
          );
          // No sub ⇒ unauthenticated. An error ⇒ unauthenticated.
          if (withError) {
            expect(result).toBeNull();
          } else {
            expect(result).toBeNull();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

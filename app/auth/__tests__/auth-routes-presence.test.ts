// Feature: google-oauth-authentication — route-presence smoke tests (Task 8.6)
//
// Validates: Requirements 20.1, 20.2, 20.3, 20.4
//
// Asserts that every Auth_Screen page and both server callback routes exist on
// disk at their expected paths, and that the service-role key is never exposed
// as a NEXT_PUBLIC_ env (redaction, Req 12.2). These are structural guarantees
// independent of a running server.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// app/auth/__tests__ → repo root
const ROOT = path.resolve(__dirname, "..", "..", "..");

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

describe("Auth_Screens are present (Req 20.1–20.3)", () => {
  const screens: Array<[string, string]> = [
    ["/login", "app/login/page.tsx"],
    ["/signup", "app/signup/page.tsx"],
    ["/forgot-password", "app/forgot-password/page.tsx"],
    ["/reset-password", "app/reset-password/page.tsx"],
    ["/set-password", "app/set-password/page.tsx"],
    ["/verify-email (verification result)", "app/verify-email/page.tsx"],
  ];

  it.each(screens)("has a page for %s", (_label, file) => {
    expect(exists(file)).toBe(true);
  });
});

describe("Server callback routes are present (Req 20.4)", () => {
  const routes: Array<[string, string]> = [
    ["/auth/callback", "app/auth/callback/route.ts"],
    ["/auth/confirm", "app/auth/confirm/route.ts"],
  ];

  it.each(routes)("has a route handler for %s", (_label, file) => {
    expect(exists(file)).toBe(true);
  });
});

describe("Redaction (Req 12.2)", () => {
  it("never exposes the service-role key under a NEXT_PUBLIC_ name in example env", () => {
    const envExample = path.join(ROOT, ".env.example");
    if (!fs.existsSync(envExample)) return; // nothing to assert
    const contents = fs.readFileSync(envExample, "utf8");
    expect(/NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE/i.test(contents)).toBe(false);
  });
});

/**
 * Build-based regression test for the service-role capability boundary.
 *
 * Feature: google-oauth-authentication (incident fix for deployment 260ec8b)
 *
 * ── What this reproduces ─────────────────────────────────────────────────────
 *
 * On 260ec8b, `GET /api/conversations` 500'd in production because the service-
 * role guard authorized callers by their SOURCE-FILE path parsed from a stack
 * trace. In the bundled `.next/server/chunks/*` output every module collapses
 * into opaque chunk files, so the legitimate flag-false legacy-compatibility
 * call was seen as a "non-allowlisted module" and the hard-violation guard
 * threw before any DB query ran.
 *
 * Unit tests mock the module graph and therefore CANNOT catch this — the whole
 * point of the bug is that it only manifests in the BUNDLED server. This test
 * runs a real `next build` and exercises the built server
 * (`.next/server/chunks` code) with `AUTH_SUPABASE_CUTOVER_ENABLED=false`
 * against an old-schema-compatible mock Supabase, authenticates through the
 * legacy owner login, and asserts `GET /api/conversations` returns 200.
 *
 *   - BEFORE the fix (stack/filename guard): the bundled call throws the hard
 *     violation → the route returns 500 → this test FAILS.
 *   - AFTER the fix (explicit capability boundary): the capability is a value
 *     threaded through the call site, unaffected by bundling → the route
 *     reaches the mock PostgREST → 200 → this test PASSES.
 *
 * ── Why it is gated behind RUN_BUILD_IT ──────────────────────────────────────
 *
 * It runs `next build` + `next start`, which takes minutes — far too slow for
 * the default unit suite. It is a no-op skip unless `RUN_BUILD_IT=1`, and is
 * run explicitly via `npm run test:build-it`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const ENABLED = process.env.RUN_BUILD_IT === "1";
const ROOT = path.resolve(__dirname, "..", "..", "..");

// Long-running build + server boot.
const BUILD_TIMEOUT_MS = 10 * 60_000;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("could not acquire a free port"));
      }
    });
  });
}

/**
 * A minimal OLD-SCHEMA-compatible mock of Supabase PostgREST. It only knows the
 * production `conversations` table shape (keyed by `workspace_id`) and returns
 * an empty array — exactly what the un-migrated production DB would return for a
 * fresh query. Any request path reaching here at all proves the service-role
 * client was constructed successfully (i.e. the guard did NOT throw).
 */
function startMockSupabase(port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    // Drain any request body.
    req.on("data", () => {});
    req.on("end", () => {
      if (url.startsWith("/rest/v1/conversations")) {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-range": "0-0/0",
        });
        res.end("[]");
        return;
      }
      // Any other table/endpoint: respond empty-OK so the route cannot 500 for
      // an unrelated reason (the test asserts specifically on /api/conversations).
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${baseUrl}/login`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("server did not start in time"));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return request(url, "POST", { "content-type": "application/json" }, JSON.stringify(body));
}

async function getWithCookie(
  url: string,
  cookie: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return request(url, "GET", cookie ? { cookie } : {});
}

function request(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe.skipIf(!ENABLED)("bundled server: flag-false legacy GET /api/conversations (build IT)", () => {
  let mock: http.Server;
  let serverProc: ChildProcess | undefined;
  let appPort: number;
  let mockPort: number;
  const OWNER_USER = "owner";
  const OWNER_PASS = "owner-build-it-password";
  const SESSION_SECRET = "build-it-session-secret-at-least-32-characters-long";

  beforeAll(async () => {
    mockPort = await freePort();
    appPort = await freePort();
    mock = startMockSupabase(mockPort);

    const env = {
      ...process.env,
      NODE_ENV: "production",
      AUTH_SUPABASE_CUTOVER_ENABLED: "false",
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-build-it",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key-build-it",
      TEMP_OWNER_USERNAME: OWNER_USER,
      TEMP_OWNER_PASSWORD: OWNER_PASS,
      TEMP_DEMO_USERNAME: "demo",
      TEMP_DEMO_PASSWORD: "demo-build-it-password",
      TEMP_SESSION_SECRET: SESSION_SECRET,
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-build-it",
      OPENAI_API_KEY: "sk-build-it",
    } as NodeJS.ProcessEnv;

    // 1. Real production build → produces .next/server/chunks/*
    const build = spawnSync("npx", ["next", "build"], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (build.status !== 0) {
      throw new Error(
        `next build failed (status ${build.status}):\n${build.stdout}\n${build.stderr}`,
      );
    }

    // 2. Start the BUILT server (serves bundled chunk code).
    serverProc = spawn("npx", ["next", "start", "-p", String(appPort)], {
      cwd: ROOT,
      env,
      stdio: "pipe",
    });
    serverProc.stdout?.on("data", () => {});
    serverProc.stderr?.on("data", () => {});

    await waitForServer(`http://127.0.0.1:${appPort}`, 60_000);
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    serverProc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    mock?.close();
  });

  it("authenticates via legacy login and GET /api/conversations returns 200 (not 500)", async () => {
    const base = `http://127.0.0.1:${appPort}`;

    // Legacy owner login → sets cg_session cookie.
    const login = await postJson(`${base}/api/auth/login`, {
      username: OWNER_USER,
      password: OWNER_PASS,
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"]?.[0] ?? "";
    const cookie = setCookie.split(";")[0];
    expect(cookie).toMatch(/^cg_session=/);

    // The regression assertion: bundled flag-false path must construct the
    // service-role client and reach the mock → 200. Before the fix this was 500
    // (hard-violation guard rejected the opaque chunk caller path).
    const res = await getWithCookie(`${base}/api/conversations`, cookie);
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.text)).not.toThrow();
  });
});

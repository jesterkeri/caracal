// Codex R4 #1: the browser Supabase client's deadline ended when the headers
// arrived. A server that answers its headers at once and never finishes the
// body kept the request (and supabase-js's session lock) open forever.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchWithDeadline } from "../src/lib/supabase/client";

let server: Server;
let url = "";
let mode: "stall-body" | "complete" | "no-content" = "stall-body";
beforeEach(async () => {
  server = createServer((_req, res) => {
    if (mode === "no-content") return void res.writeHead(204).end();
    res.writeHead(200, { "Content-Type": "application/json" });
    if (mode === "complete") return void res.end('{"ok":true}');
    res.write('{"access_token":'); // headers and part of the body, then nothing
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/v1/user`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("codex r4 #1: the Supabase deadline covers the response body", () => {
  it("headers at once, body never completes: the request fails at the deadline", async () => {
    mode = "stall-body";
    const t0 = Date.now();
    const outcome = await Promise.race([
      fetchWithDeadline(300)(url).then(
        async (r) => `resolved; body read: ${await r.text().then(() => "finished", () => "failed")}`,
        (e: { name?: string }) => `rejected:${e.name}`,
      ),
      new Promise<string>((r) => setTimeout(() => r("still open after 3 s"), 3000)),
    ]);
    expect(outcome).toBe("rejected:TimeoutError");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a complete answer is passed on whole, status and headers kept", async () => {
    mode = "complete";
    const r = await fetchWithDeadline(300)(url);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ ok: true });
  });

  it("a 204 is passed on with no body", async () => {
    mode = "no-content";
    const r = await fetchWithDeadline(300)(url);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
  });
});

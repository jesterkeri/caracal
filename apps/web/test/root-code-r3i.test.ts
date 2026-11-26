// Adversary r3i suspicion: Supabase falls back to the site root with ?code= if
// /auth/callback is not on its allow list; the root must finish sign-in.
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/route";

describe("site root", () => {
  it("passes a sign-in code on to /auth/callback, and only the code", async () => {
    const r = GET(new Request("http://localhost:3000/?code=abc-123&next=https://evil.example"));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("http://localhost:3000/auth/callback?code=abc-123");
  });
  it("an error still goes to /signin with a known code, even with a code present", async () => {
    const r = GET(new Request("http://localhost:3000/?code=abc&error=access_denied"));
    expect(r.headers.get("location")).toBe("http://localhost:3000/signin?error=cancelled");
  });
  it("no parameters: /signin", async () => {
    const r = GET(new Request("http://localhost:3000/"));
    expect(r.headers.get("location")).toBe("http://localhost:3000/signin");
  });
});

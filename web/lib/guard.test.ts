// @vitest-environment node
import { describe, expect, it } from "vitest";
import { guardRedirect, safeNext } from "./guard";

describe("safeNext", () => {
  it("allows same-origin app paths", () => {
    expect(safeNext("/contacts?status=sent")).toBe("/contacts?status=sent");
  });
  it("falls back to the dashboard for anything that could leave the origin or loop", () => {
    for (const v of [null, "", "contacts", "//evil.example", "/\\evil.example", "https://evil.example", "/login", "/login?next=/x", "/api/auth/me"]) {
      expect(safeNext(v), String(v)).toBe("/dashboard");
    }
  });
  it("rejects control characters and backslashes the URL parser would strip or rewrite (open redirect)", () => {
    const evil = [
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r\\evil.com",
      "/\t\t/evil.com",
      " //evil.com",
      "/\u0000/evil.com",
      "/\u007f/evil.com",
      "//evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "https://evil.com",
      "http:evil.com",
      "javascript:alert(1)",
      "/%09/evil.com/../..",
      "%2F%2Fevil.com",
      "/%5Cevil.com",
      "/./%2F/evil.com",
      "/login%3Fx",
      "/LOGIN",
      "/api%2Fauth",
    ];
    for (const v of evil) {
      const out = safeNext(v);
      expect(new URL(out, "https://app.example").origin, JSON.stringify(v)).toBe("https://app.example");
      expect(out.startsWith("//") || out.includes("\\"), JSON.stringify(v)).toBe(false);
    }
    for (const v of ["/\t/evil.com", "/\n/evil.com", "/\r\\evil.com", "javascript:alert(1)", "%2F%2Fevil.com", "/%5Cevil.com", "/LOGIN"]) {
      expect(safeNext(v), JSON.stringify(v)).toBe("/dashboard");
    }
  });
  it("keeps legitimate paths with query and hash", () => {
    expect(safeNext("/contacts?status=sent&q=a%20b#row-3")).toBe("/contacts?status=sent&q=a%20b#row-3");
    expect(safeNext("/dashboard#replies")).toBe("/dashboard#replies");
    expect(safeNext("/upload")).toBe("/upload");
  });
});

describe("guardRedirect", () => {
  it("sends anonymous visitors of app pages to login, remembering where they were going", () => {
    expect(guardRedirect("/contacts", "?status=sent", false)).toBe("/login?next=%2Fcontacts%3Fstatus%3Dsent");
    expect(guardRedirect("/", "", false)).toBe("/login");
  });
  it("lets anonymous visitors see the login page", () => {
    expect(guardRedirect("/login", "", false)).toBeNull();
  });
  it("sends signed-in users away from login and the root", () => {
    expect(guardRedirect("/login", "?next=%2Fupload", true)).toBe("/upload");
    expect(guardRedirect("/", "", true)).toBe("/dashboard");
  });
  it("a signed-in user's /login?next= redirect always stays on this origin", () => {
    for (const raw of ["/\t/evil.com", "/\n/evil.com", "/\r\\evil.com", "//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)"]) {
      const target = guardRedirect("/login", `?next=${encodeURIComponent(raw)}`, true)!;
      expect(new URL(target, "http://localhost:3001").origin, JSON.stringify(raw)).toBe("http://localhost:3001");
    }
  });
  it("lets signed-in users through to app pages", () => {
    expect(guardRedirect("/dashboard", "", true)).toBeNull();
  });
});

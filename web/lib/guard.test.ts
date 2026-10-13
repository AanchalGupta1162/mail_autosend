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
  it("lets signed-in users through to app pages", () => {
    expect(guardRedirect("/dashboard", "", true)).toBeNull();
  });
});

import { createTestDb } from "./db.js";
import { createApp } from "../../src/server/app.js";
import { loadServerConfig } from "../../src/server/env.js";
import { hashPassword } from "../../src/auth/password.js";

export const TEST_PASSWORD = "correct-horse-battery";

const silent = { error() {}, warn() {}, info() {} };

// Real app on a random port, real Postgres in a throwaway schema, real HTTP.
export async function startTestApp(envOverrides = {}, { defaultRateLimit = false, appOptions = {} } = {}) {
  const db = await createTestDb();
  const config = loadServerConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SESSION_SECRET: "s".repeat(40),
    NODE_ENV: "test",
    ...envOverrides,
  });
  const app = createApp({
    pool: db.pool,
    config,
    logger: silent,
    ...appOptions,
    ...(defaultRateLimit ? {} : { loginRateLimit: { limit: 10_000 } }),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  async function addUser(username = "admin", password = TEST_PASSWORD) {
    const hash = await hashPassword(password);
    const { rows } = await db.pool.query(
      "insert into users(username, password_hash) values($1,$2) returning id",
      [username, hash],
    );
    return rows[0].id;
  }

  return {
    url,
    pool: db.pool,
    config,
    addUser,
    client: () => new Client(url),
    async close() {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

// Minimal cookie-jar fetch client.
export class Client {
  constructor(url) {
    this.url = url;
    this.cookies = new Map();
    this.csrf = null;
  }
  get sid() {
    return this.cookies.get("sid");
  }
  async raw(method, path, { body, headers = {}, csrf = true, rawBody } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (csrf && this.csrf && !("x-csrf-token" in h)) h["x-csrf-token"] = this.csrf;
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h["content-type"] = "application/json";
    }
    const res = await fetch(this.url + path, { method, headers: h, body: payload, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (/;\s*expires=Thu, 01 Jan 1970/i.test(sc) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, text, json, setCookie: res.headers.getSetCookie() };
  }
  get(path, o) {
    return this.raw("GET", path, o);
  }
  post(path, body, o = {}) {
    return this.raw("POST", path, { ...o, body });
  }
  async fetchCsrf() {
    const r = await this.get("/api/auth/csrf");
    this.csrf = r.json.csrfToken;
    return r;
  }
  async login(username = "admin", password = TEST_PASSWORD) {
    if (!this.csrf) await this.fetchCsrf();
    const r = await this.post("/api/auth/login", { username, password });
    if (r.status === 200) this.csrf = r.json.csrfToken;
    return r;
  }
}

import pg from "pg";

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

// pg-connection-string warns that sslmode=require/prefer/verify-ca will change
// meaning in pg v9 (libpq semantics). Today pg treats them as full verification,
// so we make that explicit with sslmode=verify-full: same strictness, no warning,
// and TLS verification is not weakened. channel_binding=require is accepted by
// pg as-is (verified against Neon), so it is left in place.
export function normalizeConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }
  const mode = url.searchParams.get("sslmode");
  if (["require", "prefer", "verify-ca"].includes(mode) && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("sslmode", "verify-full");
  }
  return url.toString();
}

// schema: optional; sets search_path on every new connection (SET on connect
// rather than the startup `options` param, because Neon's pooled endpoints
// reject startup options). Name is validated, so it is safe to interpolate.
export function createPool({ connectionString, schema, max = 5 }) {
  if (!connectionString) throw new Error("connectionString is required");
  if (schema !== undefined && !SCHEMA_RE.test(schema)) throw new Error("Invalid schema name");
  let Client = pg.Client;
  if (schema) {
    // Subclass so the SET completes before the pool hands the client out.
    Client = class extends pg.Client {
      connect(cb) {
        const run = async () => {
          await super.connect();
          await this.query(`SET search_path TO ${schema}`);
        };
        if (typeof cb === "function") {
          run().then(() => cb(null), (err) => cb(err));
          return undefined;
        }
        return run();
      }
    };
  }
  const pool = new pg.Pool({
    connectionString: normalizeConnectionString(connectionString),
    max,
    idleTimeoutMillis: 10_000,
    Client,
  });
  pool.on("error", (err) => console.error("pg pool error:", err.code ?? err.message));
  return pool;
}

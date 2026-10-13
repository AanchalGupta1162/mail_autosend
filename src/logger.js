// One-line JSON logs on stdout/stderr so Cloud Logging picks up `severity` and `message`.
// Callers pass a short fixed message plus non-secret fields; never tokens, passwords, URLs or bodies.
const SEVERITY = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR" };

// An Error (or error-like object) passed as fields is reduced to name and code: its message and
// stack can carry secrets (connection strings, SMTP responses), so they are never logged.
function errorFields(f) {
  const errorLike = f instanceof Error || (typeof f.message === "string" && ("name" in f || "code" in f || "stack" in f));
  if (!errorLike) return f;
  const out = {};
  if (f.name != null) out.name = String(f.name);
  if (f.code != null) out.code = typeof f.code === "number" ? f.code : String(f.code);
  return out;
}

export function createJsonLogger({ out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const emit = (level, msg, fields) => {
    const entry = { severity: SEVERITY[level], message: String(msg), ...(fields && typeof fields === "object" ? errorFields(fields) : {}) };
    // Keep reserved keys authoritative even if a caller's fields collide.
    entry.severity = SEVERITY[level];
    entry.message = String(msg);
    (level === "error" || level === "warn" ? err : out)(JSON.stringify(entry));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

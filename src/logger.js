// One-line JSON logs on stdout/stderr so Cloud Logging picks up `severity` and `message`.
// Callers pass a short fixed message plus non-secret fields; never tokens, passwords, URLs or bodies.
const SEVERITY = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR" };

export function createJsonLogger({ out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const emit = (level, msg, fields) => {
    const entry = { severity: SEVERITY[level], message: String(msg), ...(fields && typeof fields === "object" ? fields : {}) };
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

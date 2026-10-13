// Errors safe to show to the client. Anything else becomes a generic 500.
export class HttpError extends Error {
  // `extra` is merged into the JSON body (e.g. {refused: [...]}); callers must keep it free of internals.
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.expose = true;
    this.extra = extra;
  }
}

const BODY_PARSER_MESSAGES = {
  "entity.parse.failed": [400, "Malformed JSON body"],
  "entity.too.large": [413, "Request body too large"],
  "encoding.unsupported": [415, "Unsupported encoding"],
  "charset.unsupported": [415, "Unsupported charset"],
  "request.aborted": [400, "Request aborted"],
};

export function notFound(_req, res) {
  res.status(404).json({ error: "Not found" });
}

// Central handler: `{error}` only; no stack, SQL, or internals reach the client.
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return res.status(err.status).json({ ...err.extra, error: err.message });
    const mapped = BODY_PARSER_MESSAGES[err?.type];
    if (mapped) return res.status(mapped[0]).json({ error: mapped[1] });
    logger.error(`${req.method} ${req.path} failed: ${err?.name ?? "Error"} ${err?.code ?? ""}`.trim());
    res.status(500).json({ error: "Internal server error" });
  };
}

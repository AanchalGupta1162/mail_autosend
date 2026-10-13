import express from "express";
import helmet from "helmet";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { rateLimit } from "express-rate-limit";
import { requireAuth, requireCsrf } from "../auth/middleware.js";
import { authRouter } from "../auth/routes.js";
import { batchesRouter } from "./routes/batches.js";
import { contactsRouter } from "./routes/contacts.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { schedulingRouter } from "./routes/scheduling.js";
import { errorHandler, notFound } from "./errors.js";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// createApp({pool, config, mailer?, logger?, loginRateLimit?}) -> express app.
// The session table comes from migration 002 (resolved via the pool's search_path).
export function createApp({ pool, config, mailer, checkReply, logger = console, loginRateLimit = {} } = {}) {
  if (!pool) throw new Error("pool is required");
  if (typeof config?.sessionSecret !== "string" || config.sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  const production = config.nodeEnv === "production";
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.locals.mailer = mailer;

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "font-src": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
          ...(production ? { "upgrade-insecure-requests": [] } : {}),
        },
      },
    }),
  );

  // Public, no data, no session.
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  const PgStore = connectPgSimple(session);
  app.use(
    session({
      name: "sid",
      secret: config.sessionSecret,
      store: new PgStore({ pool, tableName: "session", createTableIfMissing: false }),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: production,
        maxAge: SESSION_TTL_MS,
        path: "/",
      },
    }),
  );

  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "100kb" }));

  // Per-IP throttle runs before CSRF/auth so floods are cut early.
  app.use(
    "/api/auth/login",
    rateLimit({
      windowMs: loginRateLimit.windowMs ?? 15 * 60 * 1000,
      limit: loginRateLimit.limit ?? 10, // tests may raise this; production uses the default
      standardHeaders: "draft-7",
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: "Too many login attempts, try again later" }),
    }),
  );

  // Deny by default: guards come before every router.
  app.use("/api", requireAuth, requireCsrf);
  app.use("/api/auth", authRouter({ pool }));
  app.use("/api/batches", batchesRouter({ pool, config }));
  app.use("/api/contacts", contactsRouter({ pool }));
  app.use("/api", schedulingRouter({ pool }));
  app.use("/api", dashboardRouter({ pool, config, checkReply, logger }));
  app.use("/api", notFound);

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}

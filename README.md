# mail-autosend

A small, single-admin web app for personalised outreach email. Upload a CSV, preview each rendered email, schedule send times, optionally tick **Follow-up** so a templated follow-up is queued after the first email, detect replies, and watch a dashboard. Postgres (Neon) is the source of truth. Mail goes out through Gmail SMTP; replies are detected over Gmail IMAP.

- `src/` is the Express API, the send worker and the reply sweep (Node 22, plain ESM JavaScript).
- `web/` is the Next.js (App Router, TypeScript) frontend. It is a separate deployable that proxies `/api/*` to the backend, so the browser only ever talks to one origin.

Nothing is sent unless a message row is `scheduled` with a due time. Uploading never schedules anything. With `DRY_RUN=true` (the default) real messages and Message-IDs are built with nodemailer's `jsonTransport` and **nothing is delivered**.

## Setup

Requirements: Node 22+, a Postgres database (a Neon URL works), and for real sending a Gmail account with an [app password](https://myaccount.google.com/apppasswords) (2-Step Verification on, IMAP enabled).

```bash
npm install
npm run web:install          # web/ has its own lockfile
cp .env.example .env         # then fill it in; see below
```

Required in `.env`: `DATABASE_URL` and `SESSION_SECRET` (at least 32 random characters, e.g. `openssl rand -hex 32`). `.env.example` documents every variable the code reads; secrets are blank on purpose and the app refuses to start without them. For real sending (`DRY_RUN=false`) it also requires `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `SIGNATURE_HTML` (inline, max 64 KB) or `SIGNATURE_PATH` pointing at an existing file (the signature HTML is appended to every email; `SIGNATURE_HTML` wins when both are set). The resume is no longer an environment file: upload PDFs in **Settings > Resumes**, mark one as the default, and the worker attaches the one each message was scheduled with (see *Resume storage* below). `RESUME_PATH` is an optional legacy fallback for messages scheduled before the library existed; a real send with neither a library resume nor that file is held, never sent without a resume. `signature.html` and `attachments/` are git-ignored: keep real files out of git.

Create the admin login once (applies migrations first; safe to run again, it updates the password and clears any lockout):

```bash
# in .env: ADMIN_USERNAME=admin, ADMIN_PASSWORD=<at least 10 characters>
npm run seed:admin
```

## Run locally

```bash
npm start                    # backend on :3000, applies pending migrations, starts the send worker
npm run web:dev              # frontend on :3001 (set BACKEND_URL if the backend is not http://localhost:3000)
```

Open http://localhost:3001 and sign in. Upload a CSV with the exact header `Company,Role,Person,Email,Subject,Mail Text,Follow-up Text` (max 1 MB and 500 rows; `**bold**` is supported in the texts; leave `Follow-up Text` empty to use the shared follow-up template from Settings). Invalid rows are reported and skipped. Then pick the rows, choose a send time (in the future, at most 90 days out, optional stagger between recipients) and confirm.

With the default `WORKER_MODE=polling` the worker polls every `POLL_INTERVAL_SECONDS` inside the backend process, sends at most `MAX_PER_TICK` messages per tick with a random gap between sends, and never exceeds `DAILY_SEND_CAP` real emails in a rolling 24 hours.

Tests and checks:

```bash
npm test                     # backend: needs DATABASE_URL; each test file uses a throwaway schema t_<random>
npm run web:test             # frontend unit tests
npm run web:lint
npm run web:build
npm run e2e:local            # end-to-end walk-through, see below
```

### Local end-to-end check

`npm run e2e:local` (`scripts/e2e-local.js`) creates a throwaway schema, starts the real app on a random port, and drives it over HTTP: login, upload `test/fixtures/sample.csv`, schedule one minute ahead, tick with an injected clock (sent through the dry-run transport), tick again when the follow-up is due and assert the threading headers (`In-Reply-To`, `References`, one `Re:` subject), and show that a simulated reply cancels a pending follow-up. It forces `DRY_RUN=true`, never delivers mail, never touches the `public` schema, and drops its schema at the end.

### Environment variables added for scale-to-zero

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_MODE` | `polling` | `polling`: in-process send and sweep pollers (local dev). `scheduled`: no pollers; work is triggered through `/internal/*`. |
| `INTERNAL_AUDIENCE` | unset | Expected OIDC audience (the backend URL). Required when `WORKER_MODE=scheduled`. |
| `INTERNAL_INVOKER_SA` | unset | Only this service account email may call `/internal/*`. Required when `WORKER_MODE=scheduled`. |
| `INTERNAL_TICK_DEADLINE_SECONDS` | `540` | Longest a single `/internal/tick` call keeps working (1-3600). |
| `SEND_WINDOW_ENFORCED` | `false` | Gate real sends to the stored daily window (set `true` in production). |
| `SWEEP_MAX_AGE_MINUTES` | `90` | Follow-ups are held when the last good reply sweep is older than this (5-1440). |
| `SIGNATURE_HTML` | unset | Raw signature HTML (max 64 KB). Takes precedence over `SIGNATURE_PATH`; no file needed. |
| `MIGRATE_ON_START` | `true` | `false` skips migrations at server start (run `node src/db/migrate.js` separately). |

## Security model

- **Authentication.** One admin account. Passwords are hashed with scrypt (N=32768, r=8, p=1, random salt) and compared in constant time. Failed logins return one generic message, unknown users cost the same work as known ones. Login is throttled per IP (10 per 15 minutes) and per account (5 consecutive failures lock it for 15 minutes, stored in the database).
- **Sessions.** `express-session` with a Postgres store; cookie `sid` is `httpOnly`, `SameSite=Strict`, `Secure` when `NODE_ENV=production`, 8 hours idle (rolling), regenerated on login, destroyed on logout. Changing the password signs out other sessions.
- **CSRF.** Every state-changing request needs the `X-CSRF-Token` header matching the per-session token (`GET /api/auth/csrf`).
- **Deny by default.** Every route except `/healthz`, `GET /api/auth/csrf` and `POST /api/auth/login` requires a session. All input is validated with zod and unknown fields are rejected; IDs are UUIDs; SQL is parameterised; CR/LF in email, subject and name fields is rejected on import. Errors return `{error}` only (no stack or SQL).
- **Headers.** Backend: helmet with a strict CSP, no CORS (same origin only), JSON bodies limited to 100 kB. Frontend: a per-request nonce CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Strict-Transport-Security` (one year) in production only. The UI renders text only, never user HTML.
- **Mail safety.** The Message-ID is stored before the SMTP call. Only failures that provably happened before any delivery are retried (up to 3 attempts). Anything ambiguous, and any send in flight for more than 10 minutes, becomes `needs_review` and is never resent automatically. Before each send the worker re-checks the contact (replied, opted out, bounced, suppressed). Suppressed addresses and addresses that replied, opted out or bounced are never sent to.
- **Resolving `needs_review`.** On the Contacts page choose *It was sent* (after checking your Sent folder), *Send again* (the stored Message-ID is kept so threading and reply detection stay consistent; this does not prevent a duplicate, so if the first email did go out the recipient may get it twice) or *Drop it*. The API is `POST /api/messages/:id/resolve {action: "mark_sent" | "requeue" | "cancel"}`.
- **Holds (nothing is sent, no attempt used, contact never marked failed).** Two kinds, both put the message back about 15 minutes later:
  - *Credential or config holds* (rejected Gmail app password EAUTH, unreadable signature or legacy resume file) pause **all** real sending. The Dashboard shows "Sending paused". The worker retries once about every 15 minutes (it does not retry on every 30-second poll) and the warning clears after the next successful real send. A resume-scoped hold never overwrites one of these while it is active.
  - *Resume holds* (the message's library resume is missing, deleted from the bucket, unreadable, or there is no resume at all in real mode) affect only that message; other emails keep sending. The Dashboard shows "A message is on hold" until the message is sent, cancelled or rescheduled.
  The 3-attempt cap still applies to ordinary transient pre-send failures.
- **Dry run.** A dry-run "send" marks the contact `sent` (and blocks rescheduling it) although nothing was delivered. In real mode a follow-up whose first email was a dry run is skipped (cancelled with an explanatory reason and a `send_skipped` event), never sent.
- **Replies.** In real mode the reply sweep runs every 10 minutes (and on **Check replies now**). While reply checking is stale (no fully successful sweep in the last hour, real mode, sweep enabled) follow-ups are held; first emails are not. Automatic replies and bounces are not treated as replies. You can also mark a reply or an opt-out by hand.

### Rotating the admin password

Sign in, open **Settings > Change password**, enter the current password and a new one (at least 10 characters, different from the current one). Other signed-in sessions are signed out. If you are locked out or have lost the password, set a new `ADMIN_PASSWORD` in the environment and run `npm run seed:admin` again; it updates the password and clears the lockout.

If a password has ever been pasted into a chat, a ticket or a terminal log, treat it as exposed and rotate it.

### Behind a proxy (`TRUST_PROXY`)

The frontend proxies `/api/*` to the backend, so by default every request reaches Express from the same address and the per-IP login limit becomes one shared bucket for all clients. That is acceptable for a single admin and is the safe default.

To make the limiter see real client addresses, set `TRUST_PROXY` to the number of reverse proxies in front of Express that **append** to `X-Forwarded-For` (`0` or empty = none; only `0`-`5` are accepted, `true` is refused). Express then reads the client address that many entries from the right. Setting it too high lets a client choose its own address by sending a forged header, so set it to exactly the number of trusted hops.

What was verified locally (Next 16.4.0, with `next start` and with the standalone server, against a stub backend): the Next rewrite does **not** add `X-Forwarded-For` itself and passes an inbound header through unchanged. So the client address has to come from the platform in front of Next. On Cloud Run the front end appends the client address to `X-Forwarded-For` (documented platform behaviour, not tested here): with Express reached directly from Next in one container use `TRUST_PROXY=1`; if the backend is a separate Cloud Run service that Next calls over HTTPS, its own front end appends one more entry, so use `2`. After deploying, confirm that two different clients really get separate limiter buckets before relying on it. **Production behind TLS termination requires `TRUST_PROXY` >= 1.** With `NODE_ENV=production` the session cookie is `Secure`; if Express sits behind a proxy that terminates TLS and `TRUST_PROXY` is 0, Express sees plain HTTP and never sets the cookie (login returns 200 and every later call is 401). The server logs a loud warning at startup in that combination. `GET /api/auth/csrf` is rate limited per IP (300 per 15 minutes by default; a page load fetches it once) because it creates a session row.

A unit test (`test/auth/trustproxy.test.js`) proves the limiter keys on `X-Forwarded-For` only when `TRUST_PROXY` is set.

### Resume storage

PDFs are uploaded in **Settings > Resumes** (PDF only, up to 5 MB) and stored outside the database. Each message pins the resume's storage generation at schedule time, so replacing or renaming a resume never changes mail already scheduled.

- `RESUME_STORAGE=local` (default): files under `RESUME_LOCAL_DIR` (default `./data/resumes`). For development.
- `RESUME_STORAGE=gcs`: Google Cloud Storage. Set `RESUME_BUCKET` to the bucket name without `gs://` (the real one is `mail-autosender-resumes-codecell`, Mumbai `asia-south1`).
  - Locally, authenticate with Application Default Credentials: `gcloud auth application-default login`.
  - On Cloud Run, grant the backend's service account `roles/storage.objectUser` on that bucket only (not project-wide). No key files.
  - Reads are pinned to the stored object generation. If the bucket has Object Versioning off, an overwritten or deleted object makes the message hold (safe, never sent without its resume); enable versioning or a retention policy if you want old generations to stay readable.

## Deploy outline (not yet done; design only)

Two images, no secrets baked into either:

- `Dockerfile` (repo root): backend. Multi-stage, runs as the non-root `node` user with `NODE_ENV=production`, `CMD node src/server/server.js`, health check on `/healthz`. All settings come from the environment at run time. Provide the signature with `SIGNATURE_HTML` (for example a Secret Manager secret exposed as an env var) or mount `signature.html` and point `SIGNATURE_PATH` at it. Resumes live in the storage bucket (`RESUME_STORAGE=gcs`), not in the image. `node src/db/migrate.js` is a standalone entrypoint in the same image (use it as a separate migrate job).
- `web/Dockerfile`: frontend, Next.js standalone server on port 3001, non-root. Build with the backend's URL, because it is baked into the `/api/*` rewrite when `next build` runs:
  `docker build -f web/Dockerfile --build-arg BACKEND_URL=https://<backend> web`

Both Dockerfiles pin `node:22-bookworm-slim` by digest (multi-arch index). Refresh with `docker buildx imagetools inspect node:22-bookworm-slim`. `.dockerignore` (root and `web/`) keeps `.env*`, `attachments/`, `signature.html`, `.git`, `.superpowers/`, `.impeccable/`, `docs/`, `infra/`, `test/` and `node_modules` out of the build context. These images have been read through but **not built in this environment** (no running Docker daemon at the time), so run a build before relying on them.

### Scale-to-zero (Cloud Run + Cloud Scheduler)

Postgres is the queue, so the backend does not need to stay up. Run it with `WORKER_MODE=scheduled`: the server only serves HTTP and starts **no** in-process pollers. Cloud Scheduler wakes it with OIDC-authenticated POSTs:

- `POST /internal/tick` loops the send worker until nothing is due, the send window closes, `INTERNAL_TICK_DEADLINE_SECONDS` passes, or the service shuts down. Response: `{ok, reason, iterations, summary}` where `reason` is `idle | window_closed | deadline | paused | shutdown | iteration_cap`. A call that overlaps a running tick returns `200 {ok, skipped: true, reason: "in_progress"}` (so Scheduler does not retry it).
- `POST /internal/sweep` runs the reply sweep (same single-flight as `POST /api/sweep`) and returns `{ok, result}`; a sweep already running yields `200` with `result: {skipped: true, reason: "in_progress"}`.
- Auth: a Google-signed ID token whose audience is `INTERNAL_AUDIENCE` (the backend URL) and whose `email` is `INTERNAL_INVOKER_SA` with `email_verified`. No/invalid token is `401`, a valid token from another account is `403`; the body never says why. These are the only routes (besides `/healthz`) mounted before the session/CSRF guards; a browser session does not authenticate them. `WORKER_MODE=scheduled` refuses to start without both settings.
- Send window: real sends are claimed only inside the daily window when `SEND_WINDOW_ENFORCED=true` (production). The window lives in the settings table (default 09:00-10:00 `Asia/Kolkata`; start inclusive, end exclusive, same day) and is edited in Settings > Send window or via `GET/PUT /api/settings/send-window`. Dry-run and local dev (`SEND_WINDOW_ENFORCED` unset) are never gated. Messages due outside the window simply wait for the next one.
- Follow-ups are held while the last good reply sweep is older than `SWEEP_MAX_AGE_MINUTES` (default 90), so schedule a sweep shortly before the window opens.
- Set `MIGRATE_ON_START=false` in production and run `node src/db/migrate.js` as a job before each rollout.
- Logs are one-line JSON (`severity`, `message`, plus fields) so Cloud Logging severity works; they never contain tokens, passwords or message bodies.

Suggested Google Cloud shape:

1. Put `DATABASE_URL`, `SESSION_SECRET`, `GMAIL_APP_PASSWORD`, `SIGNATURE_HTML` and the admin password in **Secret Manager** and expose them to Cloud Run as environment variables; never put them in the image or in `.env.example`.
2. Deploy the backend (max instances 1, min 0) and the frontend as two **Cloud Run** services over HTTPS only (`NODE_ENV=production` makes the session cookie `Secure`). Set `TRUST_PROXY` as described above.
3. Run migrations with the migrate job and seed the admin once, for example as a Cloud Run job: `node scripts/seedAdmin.js` with `ADMIN_*` set.
4. Cloud Scheduler (time zone `Asia/Kolkata`): `POST /internal/tick` every few minutes during the window (for example `*/5 9 * * *`) and `POST /internal/sweep` a few times a day, each with an OIDC token for the invoker service account. The claim logic uses `FOR UPDATE SKIP LOCKED` with an advisory lock, so a missed or duplicate wake-up is a delay, never a duplicate send.
   - **Cloud Tasks adapter (not built).** The scheduler is deliberately a database poller, not a queue. If per-message delivery times in Cloud Tasks are wanted later, an adapter can enqueue one task per scheduled message that calls the same claim-and-send code path; the database stays the source of truth.

## Known limits

- Single admin account; no user management.
- Reply detection depends on Gmail IMAP and is verified by unit tests with injected checkers, not against a live mailbox.
- The reply sweep and the send worker share one process; a hung IMAP call delays shutdown by up to two minutes.
- `npm audit --omit=dev` reports no vulnerabilities in the backend or the frontend. A full `npm --prefix web audit` still lists `braces` (via eslint-config-next's lint tooling, development only, never shipped); the suggested fix is a downgrade to eslint-config-next 14, so it is left alone.

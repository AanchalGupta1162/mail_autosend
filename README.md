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

Required in `.env`: `DATABASE_URL` and `SESSION_SECRET` (at least 32 random characters, e.g. `openssl rand -hex 32`). `.env.example` documents every variable the code reads; secrets are blank on purpose and the app refuses to start without them. For real sending (`DRY_RUN=false`) it also requires `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `SIGNATURE_PATH` and `RESUME_PATH` pointing at existing files (the signature HTML is appended to every email, the resume is attached to every email). `signature.html` and `attachments/` are git-ignored: keep real files out of git.

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

The worker polls every `POLL_INTERVAL_SECONDS` inside the backend process, sends at most `MAX_PER_TICK` messages per tick with a random gap between sends, and never exceeds `DAILY_SEND_CAP` real emails in a rolling 24 hours.

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

## Security model

- **Authentication.** One admin account. Passwords are hashed with scrypt (N=32768, r=8, p=1, random salt) and compared in constant time. Failed logins return one generic message, unknown users cost the same work as known ones. Login is throttled per IP (10 per 15 minutes) and per account (5 consecutive failures lock it for 15 minutes, stored in the database).
- **Sessions.** `express-session` with a Postgres store; cookie `sid` is `httpOnly`, `SameSite=Strict`, `Secure` when `NODE_ENV=production`, 8 hours idle (rolling), regenerated on login, destroyed on logout. Changing the password signs out other sessions.
- **CSRF.** Every state-changing request needs the `X-CSRF-Token` header matching the per-session token (`GET /api/auth/csrf`).
- **Deny by default.** Every route except `/healthz`, `GET /api/auth/csrf` and `POST /api/auth/login` requires a session. All input is validated with zod and unknown fields are rejected; IDs are UUIDs; SQL is parameterised; CR/LF in email, subject and name fields is rejected on import. Errors return `{error}` only (no stack or SQL).
- **Headers.** Backend: helmet with a strict CSP, no CORS (same origin only), JSON bodies limited to 100 kB. Frontend: a per-request nonce CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Strict-Transport-Security` (one year) in production only. The UI renders text only, never user HTML.
- **Mail safety.** The Message-ID is stored before the SMTP call. Only failures that provably happened before any delivery are retried (up to 3 attempts). Anything ambiguous, and any send in flight for more than 10 minutes, becomes `needs_review` and is never resent automatically. Before each send the worker re-checks the contact (replied, opted out, bounced, suppressed). Suppressed addresses and addresses that replied, opted out or bounced are never sent to.
- **Resolving `needs_review`.** On the Contacts page choose *It was sent* (after checking your Sent folder), *Send again* (the stored Message-ID is kept, so a duplicate would deduplicate) or *Drop it*. The API is `POST /api/messages/:id/resolve {action: "mark_sent" | "requeue" | "cancel"}`.
- **Replies.** In real mode the reply sweep runs every 10 minutes (and on **Check replies now**). While reply checking is stale (no fully successful sweep in the last hour, real mode, sweep enabled) follow-ups are held; first emails are not. Automatic replies and bounces are not treated as replies. You can also mark a reply or an opt-out by hand.

### Rotating the admin password

Sign in, open **Settings > Change password**, enter the current password and a new one (at least 10 characters, different from the current one). Other signed-in sessions are signed out. If you are locked out or have lost the password, set a new `ADMIN_PASSWORD` in the environment and run `npm run seed:admin` again; it updates the password and clears the lockout.

If a password has ever been pasted into a chat, a ticket or a terminal log, treat it as exposed and rotate it.

### Behind a proxy (`TRUST_PROXY`)

The frontend proxies `/api/*` to the backend, so by default every request reaches Express from the same address and the per-IP login limit becomes one shared bucket for all clients. That is acceptable for a single admin and is the safe default.

To make the limiter see real client addresses, set `TRUST_PROXY` to the number of reverse proxies in front of Express that **append** to `X-Forwarded-For` (`0` or empty = none; only `0`-`5` are accepted, `true` is refused). Express then reads the client address that many entries from the right. Setting it too high lets a client choose its own address by sending a forged header, so set it to exactly the number of trusted hops.

What was verified locally (Next 16.4.0, with `next start` and with the standalone server, against a stub backend): the Next rewrite does **not** add `X-Forwarded-For` itself and passes an inbound header through unchanged. So the client address has to come from the platform in front of Next. On Cloud Run the front end appends the client address to `X-Forwarded-For` (documented platform behaviour, not tested here): with Express reached directly from Next in one container use `TRUST_PROXY=1`; if the backend is a separate Cloud Run service that Next calls over HTTPS, its own front end appends one more entry, so use `2`. After deploying, confirm that two different clients really get separate limiter buckets before relying on it. A unit test (`test/auth/trustproxy.test.js`) proves the limiter keys on `X-Forwarded-For` only when `TRUST_PROXY` is set.

## Deploy outline (not yet done; design only)

Two images, no secrets baked into either:

- `Dockerfile` (repo root): backend. Multi-stage, runs as the non-root `node` user with `NODE_ENV=production`, `CMD node src/server/server.js`, health check on `/healthz`. All settings come from the environment at run time. Mount `signature.html` and the resume as files (for example Secret Manager secrets mounted as volumes) and point `SIGNATURE_PATH` and `RESUME_PATH` at them.
- `web/Dockerfile`: frontend, Next.js standalone server on port 3001, non-root. Build with the backend's URL, because it is baked into the `/api/*` rewrite when `next build` runs:
  `docker build -f web/Dockerfile --build-arg BACKEND_URL=https://<backend> web`

`.dockerignore` keeps `.env`, `attachments/`, `signature.html`, `.superpowers/` and `node_modules` out of the build context. These images have been read through but **not built in this environment** (no running Docker daemon at the time), so run a build before relying on them.

Suggested Google Cloud shape:

1. Put `DATABASE_URL`, `SESSION_SECRET`, `GMAIL_APP_PASSWORD` and the admin password in **Secret Manager** and expose them to Cloud Run as environment variables or mounted files; never put them in the image or in `.env.example`.
2. Deploy the backend and the frontend as two **Cloud Run** services (or one service with both containers) over HTTPS only (`NODE_ENV=production` makes the session cookie `Secure`). Set `TRUST_PROXY` as described above.
3. Run migrations at start (the server does this) and seed the admin once, for example as a Cloud Run job: `node scripts/seedAdmin.js` with `ADMIN_*` set.
4. Sending cadence. Today the send worker is an in-process poller: it runs every `POLL_INTERVAL_SECONDS` for as long as the backend process is running, so on Cloud Run it needs an instance that stays up with CPU always allocated (minimum instances 1). There is **no tick HTTP endpoint yet**.
   - Planned design: add an authenticated tick endpoint (verified Cloud Scheduler OIDC token) that runs one worker tick, turn the in-process poller off in that mode, and let **Cloud Scheduler** call it. The claim logic already uses `FOR UPDATE SKIP LOCKED` with an advisory lock, so concurrent ticks never send the same message.
   - Send window: the intended use is sending only between 9 and 10 am each day, by having Cloud Scheduler call the tick endpoint only in that window (a cron such as `*/2 9 * * *` in the right time zone). **A send-window setting is not implemented.** Until then, control timing by choosing send times (and the stagger) when you schedule a batch, and bound volume with `DAILY_SEND_CAP`, `MAX_PER_TICK` and the send gap.
   - **Cloud Tasks adapter (not built).** The scheduler is deliberately a database poller, not a queue. If per-message delivery times in Cloud Tasks are wanted later, an adapter can enqueue one task per scheduled message that calls the same claim-and-send code path; the database stays the source of truth.

## Known limits

- Single admin account; no user management.
- Reply detection depends on Gmail IMAP and is verified by unit tests with injected checkers, not against a live mailbox.
- The reply sweep and the send worker share one process; a hung IMAP call delays shutdown by up to two minutes.
- `npm audit --omit=dev` reports no vulnerabilities in the backend or the frontend. A full `npm --prefix web audit` still lists `braces` (via eslint-config-next's lint tooling, development only, never shipped); the suggested fix is a downgrade to eslint-config-next 14, so it is left alone.

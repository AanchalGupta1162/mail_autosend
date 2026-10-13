# Mail Scheduler + Dashboard Implementation Plan

**Goal:** Turn the manual CLI into an authenticated web service: upload a CSV, preview rendered emails, schedule send times, tick a Follow-up checkbox to auto-schedule a templated follow-up, detect replies, and show a dashboard. Postgres (Neon) is the source of truth. Local-first; GCP deploy comes later.

**Stack (fixed):** Node 22, ESM plain JS (no TypeScript), Express 4, `pg`, `express-session` + `connect-pg-simple`, `helmet`, `express-rate-limit`, `zod`, `multer`, existing `nodemailer`/`imapflow`/`exceljs`. Tests: `node:test` + real HTTP via `fetch` against `app.listen(0)`, real Postgres (no DB mocks). Frontend: Vite + React 18 + react-router in `web/`, plain CSS with CSS variables (light/dark), no UI kit.

## Global Constraints (binding on every task)

**Process**
- Strict TDD: failing test first, watch it fail, minimal code, green. Run the whole `npm test` before reporting.
- Commit per task (small logical commits). Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never commit secrets. `.env` is git-ignored and already holds `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`. Never print them. `.env.example` gets placeholder names only.
- Tests NEVER touch the `public` schema of the real DB. Each test file creates a throwaway schema `t_<random>` (set via `search_path`), runs migrations in it, and drops it afterwards (helper: `test/helpers/db.js`, `createTestDb()` returns `{pool, schema, close}`).
- No real email is ever sent by tests or local runs. `DRY_RUN=true` (default for local dev) uses `nodemailer` `jsonTransport` (builds the real message and Message-ID, delivers nothing). Real delivery only when `DRY_RUN=false` and Gmail credentials are set.

**Security (all must hold; reviewers check them)**
- Passwords: Node `crypto.scrypt` (N=32768, r=8, p=1, 16-byte random salt, 64-byte key), stored as self-describing string, verified with `timingSafeEqual`. Login for an unknown user must do equal work (dummy hash). Generic error `Invalid username or password` for all login failures.
- Login throttling: `express-rate-limit` per IP on `/api/auth/login` (10 / 15 min) AND per-account lockout (5 consecutive failures → locked 15 min, stored in DB).
- Sessions: `express-session` with PG store, cookie `httpOnly`, `sameSite: "strict"`, `secure` when `NODE_ENV=production`, `name: "sid"`, 8h idle (rolling), `req.session.regenerate` on login, destroyed on logout. `SESSION_SECRET` required, ≥32 chars, app refuses to start otherwise. `app.set("trust proxy", 1)` only when `TRUST_PROXY=1`.
- CSRF: every state-changing request (POST/PUT/PATCH/DELETE) except login requires header `X-CSRF-Token` equal to the per-session token (from `GET /api/auth/csrf`, compared timing-safe). Login also requires a valid CSRF token obtained pre-login (session created on csrf fetch).
- `helmet` with a strict CSP (`default-src 'self'`; no inline scripts), `x-powered-by` off, no CORS (same-origin only), JSON body limit 100kb, upload limit 1MB, max 500 rows per CSV.
- Every route except `/healthz`, `/api/auth/csrf`, `/api/auth/login` requires an authenticated session (deny by default via middleware mounted before routers).
- All SQL parameterized (no string-built SQL with user data). All input validated with `zod`; unknown fields rejected. IDs are UUIDs.
- Header-injection safe: reject CR/LF in email, subject, name fields on import. Email format validated.
- Errors: central handler returns `{error}` without stack/SQL details; log server-side without secrets or full email bodies.
- No dynamic HTML from user data on the server; the React app renders text only (no `dangerouslySetInnerHTML`). The preview shows the plain-text body; the HTML version is not injected into the DOM.
- Dependencies: `npm audit --omit=dev` shows no high/critical at the end.

**Domain rules**
- Contact statuses: `uploaded → scheduled → sent → replied | bounced | opted_out | failed`. Message states: `scheduled | sending | sent | failed | cancelled | needs_review`. Message kinds: `initial | followup`.
- Nothing is sent unless a message row is `scheduled` with `scheduled_for <= now()`. Uploading never schedules anything.
- Never send to an email in `suppressions`, nor to a contact with status `replied`/`opted_out`/`bounced`.
- Double-send is the worst failure: Message-ID is generated and stored BEFORE sending; a `sending` row older than 10 min becomes `needs_review` and is never auto-resent.

## Data model (migration `src/db/migrations/001_init.sql`, applied by `src/db/migrate.js` which tracks `schema_migrations`)
- `users(id uuid pk, username text, password_hash text, failed_attempts int, locked_until timestamptz, created_at)`, unique index on `lower(username)`.
- `batches(id uuid pk, name text, original_filename text, created_by uuid, created_at)`.
- `contacts(id uuid pk, batch_id fk, company, role, person, email, subject, mail_text, followup_text null, status, followup_requested bool default false, followup_delay_days int default 7, replied_at null, error null, created_at)`; unique `(batch_id, lower(email))`.
- `messages(id uuid pk, contact_id fk, kind, state, scheduled_for timestamptz, message_id text null, sent_at null, attempts int default 0, claimed_at null, error null, dry_run bool default false, created_at)`; partial unique index: at most one non-cancelled message per `(contact_id, kind)`; index on `(state, scheduled_for)`.
- `events(id bigserial pk, contact_id null, type text, meta jsonb, at timestamptz default now())`.
- `suppressions(email text pk (lowercase), reason text, created_at)`.
- `settings(key text pk, value jsonb)`: key `followup_template` = `{subject, body}`.
- Default follow-up template: subject `Re: {{subject}}`; body `Hi {{firstName}},\n\nJust following up on my note about the {{role}} role at {{company}}. Happy to share anything that would help.\n\nBest,\nHarshavardhan Khamkar`. Placeholders: `{{firstName}} {{person}} {{role}} {{company}} {{subject}}`; unknown placeholders are left empty, values are inserted as plain text.

## API (all JSON, prefix `/api`)
- Auth: `GET /auth/csrf`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password {currentPassword,newPassword}` (min 10 chars, must differ).
- Batches: `POST /batches` (multipart field `file`, optional `name`) → `{batch, contacts:[…with rendered preview {subject, text}], errors:[{row, message}]}`; invalid rows are reported and not inserted. `GET /batches`, `GET /batches/:id`.
- Scheduling: `POST /batches/:id/schedule {contactIds[], sendAt, staggerMinutes?}` (`sendAt` ISO, must be in the future and ≤ 90 days out; stagger spaces contacts by N minutes in order); `PUT /contacts/:id/schedule {sendAt}` (schedule or reschedule an unsent initial); `DELETE /messages/:id` (cancel a `scheduled` message → contact back to `uploaded` for initials).
- Follow-up: `PUT /contacts/:id/followup {enabled, delayDays?}` (1–60 days). Enabled + initial already `sent` → create follow-up `scheduled` at `initial.sent_at + delay`. Enabled before the initial is sent → flag stored; the worker creates the follow-up right after the initial is sent. Disabled → cancel pending follow-up. A reply cancels any pending follow-up.
- Contacts: `GET /contacts?status=&q=&batchId=&page=&pageSize=`, `POST /contacts/:id/mark-replied`, `POST /contacts/:id/opt-out` (adds suppression, cancels pending messages).
- Template: `GET /template/followup`, `PUT /template/followup {subject, body}`.
- Dashboard: `GET /dashboard` → `{totals by status, sentToday, dailyCap, repliedRate, upcoming[next 10 scheduled], recentEvents[20], byCompany[top 10]}`.
- `POST /sweep` (check replies now). `GET /healthz` (no auth, no data).

## Files (guide; adapt sensibly)
`src/server/{app.js,server.js,env.js,errors.js}`, `src/db/{pool.js,migrate.js,migrations/}`, `src/auth/*`, `src/import/parseCsv.js`, `src/domain/*` (template render, scheduling, followup, repository functions), `src/worker/{send.js,tick.js,sweep.js,poller.js}`, `scripts/seedAdmin.js`, `web/` (Vite app), `test/**`. Reuse `src/compose.js`, `src/mailer.js`, `src/imap.js`. Legacy CLI modules (`src/index.js`, `scheduler.js`, `queue.js`, `excel.js`, their tests) stay untouched until Task 7.

---

### Task 1: Foundation: env, DB pool, migrations, test harness

Create `src/server/env.js` (zod-validated `loadServerConfig()`: `DATABASE_URL`, `SESSION_SECRET`≥32, `NODE_ENV`, `PORT` default 3000, `DRY_RUN` default true, `DAILY_SEND_CAP` default 100, `MAX_PER_TICK` default 5, `SEND_GAP_SECONDS_MIN/MAX` default 15/45, `TRUST_PROXY`, plus existing Gmail vars). `src/db/pool.js` (`createPool({connectionString, schema?})`; schema sets `search_path` per connection via options; SSL from the URL; handle the Neon `channel_binding` param: if `pg` rejects it, strip it in code and explain in a comment). `src/db/migrate.js` + `001_init.sql` per the data model. `test/helpers/db.js` `createTestDb()`. Add scripts: `"start": "node --env-file=.env src/server/server.js"`, `"migrate"`, `"seed:admin"`, `"test"` loading `.env` via `--env-file`. Keep existing legacy scripts under new names (`"legacy:start"`). Tests: config validation (rejects short secret), migrations create all tables and are idempotent, test-schema isolation (nothing created in `public`). Also run `npm run migrate` once against the real DB's `public` schema at the end (this is expected and approved) and report the table list.

### Task 2: Authentication and server skeleton

Implement `src/auth/password.js` (hash/verify per constraints), `scripts/seedAdmin.js` (idempotent upsert from `ADMIN_USERNAME`/`ADMIN_PASSWORD`; never logs the password; run it against the real DB at the end of the task and report only "admin created/updated"), `src/server/app.js` `createApp({pool, config, mailer?})` with helmet, sessions, CSRF, rate limits, deny-by-default auth middleware, error handler, `/healthz`, and the Auth routes incl. change-password and lockout. `src/server/server.js` starts it (also serves `web/dist` statically with SPA fallback if present). Tests (real HTTP): login success/failure generic message, lockout after 5, IP rate limit, CSRF missing/invalid → 403, unauthenticated API → 401, session cookie flags (httpOnly, SameSite=Strict), session regenerated on login (id differs), logout destroys session, change-password rules, password hash is not plaintext and verify is timing-safe path, helmet headers present, unknown route 404 JSON, no stack leakage.

### Task 3: CSV import, preview, batches and contacts API

`src/import/parseCsv.js`: parse a Buffer (CSV, UTF-8 with optional BOM) with the same header contract as `src/excel.js`/the `formatting-email-csv` skill (required: Company, Role, Person, Email, Subject, Mail Text; optional Follow-up Text). Returns `{rows, errors}` per-row; validates email, CR/LF in single-line fields, non-empty required fields, duplicate emails within file, ≤500 rows, suppression check (suppressed emails reported as errors). `src/domain/render.js`: initial preview via existing `composeBody` (text + html available; API returns text only). Routes: `POST /batches` (multer memory, 1MB, `.csv` only), `GET /batches`, `GET /batches/:id`, `GET /contacts` with filters/pagination, `POST /contacts/:id/mark-replied`, `POST /contacts/:id/opt-out`. Tests: valid upload, BOM, missing header, bad rows partially accepted, duplicates, oversize, wrong type, injection chars, auth/CSRF required, pagination and filters, opt-out creates suppression and cancels messages, event rows written.

### Task 4: Scheduling, follow-up checkbox, template, send worker

`src/domain/schedule.js` (schedule, reschedule, cancel, stagger; future-only and 90-day validation), follow-up logic per API section (`syncFollowup`), template get/put + `renderFollowup(contact, template)`, routes listed above. Worker: `src/worker/send.js` (build mail with existing `buildInitialMailOptions`/`buildFollowUpMailOptions`, `Re:` threading via the initial's stored Message-ID, resume attachment as existing), `src/worker/tick.js` `runTick({pool, mailer, config, now, sleep})`: claim due messages with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING`, enforce rolling-24h `DAILY_SEND_CAP`, `MAX_PER_TICK`, random jitter gap via injected `sleep`, skip+cancel if contact replied/opted-out/suppressed, pre-store Message-ID, on success mark sent and create the follow-up if flagged, on error retry up to 3 attempts with backoff then `failed`, stale `sending` > 10 min → `needs_review`. `src/worker/poller.js` (interval loop started by `server.js`, graceful stop, single in-process runner guarded against overlap). Tests: stagger math, reject past/too-far dates, reschedule/cancel, claim concurrency (two concurrent ticks never send the same message), cap, replied-skip, follow-up auto-creation timing, untick cancels, follow-up threading headers, failure/retry, needs_review, dry-run transport sends nothing and sets `dry_run`, template placeholder escaping.

### Task 5: Reply sweep and dashboard API

`src/worker/sweep.js` using existing `checkForReply` (inject for tests): for contacts `sent` and not replied, mark `replied` + `replied_at`, cancel pending follow-up, write event; IMAP failure is logged and retried next time, never treated as "no reply"; skipped in dry-run unless an injected checker is given; `POST /sweep`; poller runs it every 10 minutes when not dry-run. `GET /dashboard` per API section (aggregate SQL, no N+1). Tests: reply marks replied and cancels follow-up, IMAP error leaves state unchanged, dashboard numbers across seeded states, auth required.

### Task 6: Frontend (web/)

Vite + React 18 + react-router app, plain CSS tokens (light/dark via `prefers-color-scheme`), accessible, responsive. Pages: **Login**; **Upload** (drag-drop/choose CSV → shows row errors and a preview table of rendered emails with per-row checkbox, per-row follow-up checkbox with delay, a bulk date-time picker + optional stagger minutes, per-row override, Confirm schedule button disabled until valid); **Batches/Contacts** (filter by status, search, status badges, reschedule/cancel, follow-up checkbox, mark replied, opt out, dry-run banner); **Dashboard** (status funnel, sent today vs cap, upcoming sends, recent events, top companies; simple SVG/CSS charts, no chart lib); **Settings** (edit follow-up template with placeholder help, change password). `src/api.js` client: same-origin fetch with credentials, fetches CSRF token once and sends `X-CSRF-Token`, handles 401 by redirecting to login, 403 CSRF by refetching once. Only render user text as text. Dev proxy to `:3000`; `npm run web:build` output served by Express. Use the ui-ux / frontend design skills for craft; keep dependencies minimal. Tests with `vitest` + Testing Library for: api client CSRF/401 behavior, schedule form validation (past date rejected), preview selection logic, login form errors.

### Task 7: Hardening, cleanup, docs, local end-to-end

Remove superseded legacy CLI (`src/index.js`, `scheduler.js`, `queue.js`, legacy excel marker functions and their tests) after confirming nothing imports them (keep `compose`, `mailer`, `imap`, `config` pieces still used). Add `Dockerfile` (multi-stage, non-root user, `NODE_ENV=production`, no secrets), `.dockerignore`, `.env.example` (placeholders), README (setup, security model, local run, deploy outline for Cloud Run + Secret Manager + Cloud Tasks adapter note, how to rotate the admin password via UI). Run `npm audit --omit=dev`. Write `scripts/e2e-local.js` or a test that, against a throwaway schema, runs: login → upload `test/fixtures/sample.csv` → schedule 1 minute ahead (injected clock) → tick → asserts sent (dry-run) → tick follow-up → asserts threading → simulated reply cancels follow-up. Report the results honestly.

# Deploy and operate (GCP Cloud Run, Mumbai)

Architecture in one paragraph: `mail-web` (public Next.js) proxies `/api/*` to `mail-backend` (Express). Both scale to zero.
Cloud Scheduler wakes the backend with OIDC-authenticated calls: `send-window` (`*/5 9 * * *` IST) calls `/internal/tick`,
five `reply-sweep-*` jobs call `/internal/sweep`. Postgres (Neon) is the queue, so a missed wake-up is a delay, never a lost
or duplicate send. Sends are also gated inside the app to the 09:00-10:00 IST window (`SEND_WINDOW_ENFORCED=true`).
Infrastructure is Terraform (`infra/`), images and traffic are GitHub Actions (`.github/workflows/deploy.yml`).

Placeholders: `R=asia-south1`. Run `gcloud config set project codecell-vesit` first.

## 1. Bootstrap (one time)

Follow [`infra/README.md`](../infra/README.md): state bucket, `terraform apply`, import the resume bucket, add secret values,
set GitHub variables and the `production` environment. Then do the first-deploy checklist below.

## 2. First-deploy checklist

Do these in order; do not skip ahead. The scheduler jobs start paused and `DRY_RUN=true`.

1. **Secrets are real**: `gcloud secrets versions list <name>` shows a version newer than 1 for all six secrets
   (`mail-database-url`, `mail-gmail-user`, `mail-gmail-app-password`, `mail-session-secret`, `mail-admin-password`,
   `mail-signature-html`). Placeholders must never reach a real send. Rotate the old Neon, admin and any leaked dev
   passwords first (section 4).
2. **Deploy**: merge to `main`; approve the `production` environment. The workflow builds both images, runs the migrate job,
   smoke tests each new revision with no traffic, then shifts traffic.
3. **Seed the admin**: `gcloud run jobs execute mail-seed-admin --region $R --wait`. Log in at the `web_url`
   (`terraform output web_url`) and check the dashboard loads.
4. **Check the proxy hop count**: `TRUST_PROXY` defaults to 2 (Google front end plus the Next rewrite). Make several failed
   logins from your machine and confirm the backend logs/limiter treat you as your own address, not as one shared IP
   (`gcloud run services logs read mail-backend --region $R`). Adjust `trust_proxy_hops` in `infra/` if not.
5. **Dry run through Scheduler**: unpause the tick and call it once inside 09:00-10:00 IST, or widen the window in
   Settings > Send window for the test:

   ```sh
   gcloud scheduler jobs resume send-window --location $R
   gcloud scheduler jobs run send-window --location $R
   gcloud run services logs read mail-backend --region $R --limit 50   # expect event=internal_tick, dry-run sends recorded
   ```

   Outside the window dry runs still work (they are never gated); real sends do not.
6. **Auth check**: `curl -i -X POST $(terraform output -raw backend_url)/internal/tick` must answer 401 without a token.
7. **Real send to yourself**: set `dry_run = false` in `infra/terraform.tfvars`, `terraform apply`, schedule one message to
   your own address inside the window. Check the PDF resume from the bucket, signature, threading and the follow-up.
   Set `dry_run = true` again if anything looks wrong.
8. **Unpause sweeps**: `for j in reply-sweep-0850 reply-sweep-1000 reply-sweep-1320 reply-sweep-1640 reply-sweep-2000; do gcloud scheduler jobs resume $j --location $R; done`.
   Reply from another account, run `gcloud scheduler jobs run reply-sweep-1000 --location $R`, and confirm the contact
   turns `replied` and follow-ups are cancelled.
9. Set `sweep_alert_enabled = true` and apply, so a day without a good sweep pages you.
10. Force a failure once (for example rename a secret reference in a scratch revision) to see the alert email arrive.

## 3. Roll back

* **Normal**: a failed deploy rolls back by itself (traffic returns to the previous revisions; migrations are forward-only
  and stay applied, so keep migrations backwards compatible with the previous code).
* **Manual, a known good commit**: GitHub > Actions > Deploy > Run workflow, enter the full 40-character `sha`. Its images
  must still be in Artifact Registry (the 10 newest versions per image are kept).
* **Manual, instantly, from a terminal**:

  ```sh
  gcloud run revisions list --service mail-backend --region $R
  gcloud run services update-traffic mail-backend --region $R --to-revisions=<REVISION>=100
  gcloud run services update-traffic mail-web     --region $R --to-revisions=<REVISION>=100
  ```

  Traffic is now pinned. The next pipeline deploy returns it to "latest" automatically; to do it by hand use
  `gcloud run services update-traffic <svc> --region $R --to-latest`.

## 4. Rotate secrets

Secrets are read with version `latest` when an instance starts. Adding a version does nothing for running instances, so
roll a new revision afterwards (no config change, no Terraform drift):

```sh
printf '%s' "$NEW_VALUE" | gcloud secrets versions add <secret> --data-file=-
gcloud run services update mail-backend --region $R --revision-suffix "r$(date +%Y%m%d%H%M%S)"
gcloud run services update-traffic mail-backend --region $R --to-latest   # no-op unless traffic was pinned by a rollback
gcloud secrets versions disable <old-version> --secret <secret>   # once the new revision is healthy
```

Jobs pick up the new version on their next execution.

| Secret | Where it comes from | Notes |
| --- | --- | --- |
| `mail-database-url` | Neon: reset the role password, copy the pooled connection string | Used by backend and the migrate/seed jobs |
| `mail-gmail-app-password` | myaccount.google.com/apppasswords (revoke the old one) | A rejected password creates a send hold and an alert |
| `mail-gmail-user` | The sending Gmail address | Rarely changes |
| `mail-session-secret` | `openssl rand -hex 32` | Rotating signs everyone out |
| `mail-admin-password` | Choose a strong one (10+ chars) | Then run `gcloud run jobs execute mail-seed-admin --region $R --wait` to apply it and clear any lockout |
| `mail-signature-html` | `signature.html` | Max 64 KB; check the preview in the UI |

Rotate after any suspected leak, after a collaborator leaves, and at least yearly. The GitHub side has nothing to rotate:
Workload Identity Federation uses no long-lived keys.

## 5. Restore the database (Neon point in time)

1. Stop writes: `gcloud scheduler jobs pause send-window --location $R` (and the sweeps), so nothing sends while data is rewound.
2. In the Neon console open the production branch > Restore, choose the timestamp (or restore to a new branch and compare).
   History retention depends on your Neon plan; check the window before you need it.
3. If you restored to a new branch, put its pooled connection string into `mail-database-url` (section 4) and roll the backend.
4. Remember what a rewind means: sends that happened after the restore point are not in the database any more. Check the
   Gmail Sent folder before resuming so contacts are not emailed twice, and mark them replied or cancelled in the UI.
5. Resume the scheduler jobs once the dashboard shows the expected state.

The resume library lives in `gs://mail-autosender-resumes-codecell` with object versioning: restore a deleted or
overwritten file with `gcloud storage cp gs://<bucket>/<object>#<generation> gs://<bucket>/<object>`.

## 6. Stop sending quickly

Fastest first:

```sh
gcloud scheduler jobs pause send-window --location $R              # no more tick wake-ups (nothing is lost; the queue waits)
gcloud run services update mail-backend --region $R --update-env-vars DRY_RUN=true   # in-flight and any manual runs stop going to Gmail
```

The second command makes Terraform differ from reality until you set `dry_run = true` in your tfvars and apply (or revert).
To also stop reply checks, pause the five `reply-sweep-*` jobs. Resume with `gcloud scheduler jobs resume <name>`. Pausing
the scheduler is safe at any time; the app never double sends and picks up where it left off.

## 7. Seed or reset the admin

`mail-seed-admin` upserts the user named by `admin_username` with the password in `mail-admin-password`, applies pending
migrations and clears any lockout:

```sh
gcloud run jobs execute mail-seed-admin --region $R --wait
```

Locked out? Same command. Forgot the username? `terraform output`/tfvars `admin_username`. To change the password, add a new
`mail-admin-password` version first.

## 8. Cost expectations

Roughly 1 to 3 USD per month, mostly Secret Manager and Cloud Scheduler line items, because nothing runs while idle:

* Cloud Run: request-time billing, scale to zero; a daily window of a few minutes stays inside the free tier.
* Cloud Scheduler: 6 jobs (the first 3 per billing account are free, about 0.10 USD each after).
* Secret Manager: 6 secrets with a couple of versions each (a few cents).
* Artifact Registry: two small images, cleanup keeps the newest 10 versions (about 0.10 USD per GB over the free 0.5 GB).
* Monitoring, Logging, uptime check (every 15 min, mail-web only): inside free allowances at this volume.
* Neon and Gmail are billed separately (free tiers are enough for this load).

The budget alert emails at 50% and 100% (and forecast 100%) of `budget_amount_usd` (default 10). Prices change: verify on the
Google Cloud pricing pages before relying on these numbers.

## 9. Monitoring and alerts

Email alerts go to `alert_email`: 5xx burst, backend ERROR logs, Scheduler job failures, a send hold or `needs_review` or
failed messages (from the `internal_tick` log line), no successful sweep in about a day, `mail-web /login` down, and budget.
The dashboard also shows the send-hold banner. Useful commands:

```sh
gcloud run services logs read mail-backend --region $R --limit 100
gcloud scheduler jobs list --location $R
gcloud scheduler jobs describe send-window --location $R
```

# Infrastructure (Terraform)

Everything for the Mumbai (`asia-south1`) deployment of project `codecell-vesit`: APIs, service accounts, Artifact Registry,
Secret Manager containers, Cloud Run services and jobs, Cloud Scheduler, Workload Identity Federation for GitHub Actions,
the resume bucket binding, alerts, uptime check and budget. Terraform owns configuration; GitHub Actions owns container
images and traffic (`lifecycle { ignore_changes }` on image and traffic). Secret values never enter Terraform or its state.

| File | What |
| --- | --- |
| `versions.tf` | Terraform and provider pins, GCS backend (`codecell-vesit-tfstate`, prefix `mail-autosender/infra`) |
| `apis.tf` | Enabled APIs |
| `iam.tf` | Service accounts and least-privilege roles (backend, web, migrate, scheduler-invoker, github-deployer, github-planner) |
| `secrets.tf` | Secret containers, accessor bindings, optional placeholder version 1 |
| `cloud_run.tf` | `mail-backend`, `mail-web`, jobs `mail-migrate` and `mail-seed-admin` |
| `scheduler.tf` | `send-window` and five `reply-sweep-*` jobs (Asia/Kolkata, OIDC) |
| `wif.tf` | Workload Identity pool, two providers, impersonation bindings |
| `bucket.tf` | Existing resume bucket (import) and the backend's `objectUser` binding |
| `monitoring.tf` | Alert policies, log metric, uptime check, budget |

## Bootstrap (one time, from a workstation)

Prerequisites: `gcloud` logged in as an owner of the project (`gcloud auth login` and
`gcloud auth application-default login`), Terraform >= 1.9. Nothing here is run by CI.

1. **Minimum APIs** (Terraform enables the rest, but needs these to talk to the API at all):

   ```sh
   gcloud config set project codecell-vesit
   gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
     iam.googleapis.com storage.googleapis.com cloudbilling.googleapis.com
   ```

2. **State bucket** (versioned, private, same region; created by hand, not by Terraform):

   ```sh
   gcloud storage buckets create gs://codecell-vesit-tfstate \
     --project=codecell-vesit --location=asia-south1 \
     --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://codecell-vesit-tfstate --versioning
   ```

3. **Variables**:

   ```sh
   cd infra
   cp terraform.tfvars.example terraform.tfvars   # set alert_email and, if you want the budget, billing_account_id
   terraform init
   ```

4. **Import the existing resume bucket** (it holds real data; do not let Terraform create it):

   ```sh
   terraform import google_storage_bucket.resumes codecell-vesit/mail-autosender-resumes-codecell
   ```

   Run `terraform plan` and compare the bucket's planned changes with
   `gcloud storage buckets describe gs://mail-autosender-resumes-codecell`. Settings that differ (storage class,
   versioning, public access prevention) are changed on apply: make sure each is intended before applying.

5. **Review and apply**:

   ```sh
   terraform plan -out=tfplan
   terraform apply tfplan
   ```

   First apply uses a public placeholder image and a throwaway "placeholder" version 1 in every secret
   (`seed_placeholder_secret_versions`) so Cloud Run can start before real values exist. Scheduler jobs are created paused,
   `DRY_RUN=true`. If an apply fails right after creating service accounts with a "does not exist" IAM error, re-run it
   (IAM propagation).

6. **Add the real secret values** (read from stdin so they never reach shell history or state):

   ```sh
   printf '%s' "postgres://...prod pooled url..." | gcloud secrets versions add mail-database-url --data-file=-
   printf '%s' "you@gmail.com"                    | gcloud secrets versions add mail-gmail-user --data-file=-
   read -rs GMAIL_APP_PASSWORD; printf '%s' "$GMAIL_APP_PASSWORD" | gcloud secrets versions add mail-gmail-app-password --data-file=-; unset GMAIL_APP_PASSWORD
   openssl rand -hex 32                           | tr -d '\n' | gcloud secrets versions add mail-session-secret --data-file=-
   read -rs ADMIN_PASSWORD; printf '%s' "$ADMIN_PASSWORD" | gcloud secrets versions add mail-admin-password --data-file=-; unset ADMIN_PASSWORD
   gcloud secrets versions add mail-signature-html --data-file=signature.html
   gcloud secrets versions list mail-database-url   # every secret must show a version newer than the placeholder (1)
   ```

7. **GitHub repository variables** (variables, not secrets; none of these are sensitive):

   ```sh
   cd infra
   gh variable set GCP_PROJECT       --body codecell-vesit
   gh variable set GCP_REGION        --body asia-south1
   gh variable set WIF_PROVIDER      --body "$(terraform output -raw wif_provider)"
   gh variable set DEPLOY_SA         --body "$(terraform output -raw deployer_service_account)"
   gh variable set WIF_PROVIDER_PLAN --body "$(terraform output -raw wif_provider_plan)"
   gh variable set PLAN_SA           --body "$(terraform output -raw planner_service_account)"
   gh variable set ALERT_EMAIL       --body you@example.com
   gh variable set BILLING_ACCOUNT_ID --body XXXXXX-XXXXXX-XXXXXX   # or leave unset and empty-default
   ```

   Also in the repo settings: create environment `production` with yourself as required reviewer, and protect `main`
   (pull request required; required status check `CI passed`).

8. First deploy: merge to `main` (or run the Deploy workflow). Continue with the first-deploy checklist in
   [`docs/deploy.md`](../docs/deploy.md).

## Day-to-day

* Config changes (env vars, schedules, alerts): edit `.tf`, open a PR (the `Terraform plan` workflow comments the diff),
  merge, then `terraform apply` locally. CI deliberately has no apply identity.
* Image rollouts are never Terraform's job. After a rollback to a pinned revision, a Terraform-created revision will not
  take traffic until you run `gcloud run services update-traffic <svc> --to-latest`.
* `terraform plan` in CI uses `-refresh=false` (the read-only identity cannot read secret payloads). Run a full
  `terraform plan` locally now and then to see drift.
* Scheduler `paused` is only honoured at creation. Pause/resume with `gcloud scheduler jobs pause|resume <name>`.

## Notes and limits

* The "no successful reply sweep" alert uses a 23.5 h window because Cloud Monitoring caps absence conditions at 24 h.
  It is off until `sweep_alert_enabled = true` (dry-run sweeps are skipped and would alert).
* Hold/needs-review alerting keys on the `internal_tick` log line the app writes on every tick
  (`held`, `needsReview`, `failed`, `reason=paused`). It fires only while a window is processed, not from the database.
* `github-planner` has `roles/viewer` and state-bucket access only. It cannot change anything in the project.

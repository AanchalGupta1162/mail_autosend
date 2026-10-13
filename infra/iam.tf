# One service account per workload, each with only what it needs. No primitive roles (owner/editor) anywhere.

resource "google_service_account" "backend" {
  account_id   = "mail-backend"
  display_name = "mail-backend Cloud Run runtime"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "web" {
  account_id   = "mail-web"
  display_name = "mail-web Cloud Run runtime (no permissions)"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "migrate" {
  account_id   = "mail-migrate"
  display_name = "Cloud Run jobs: migrate and seed-admin (database + admin password only)"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "scheduler_invoker" {
  account_id   = "scheduler-invoker"
  display_name = "Cloud Scheduler: calls /internal/* with an OIDC token"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "github_deployer" {
  account_id   = "github-deployer"
  display_name = "GitHub Actions deploy identity (WIF, main branch only)"
  depends_on   = [google_project_service.enabled]
}

resource "google_service_account" "github_planner" {
  account_id   = "github-planner"
  display_name = "GitHub Actions terraform plan identity (WIF, read-only)"
  depends_on   = [google_project_service.enabled]
}

# --- Scheduler may call the backend (also public at the IAM layer, see cloud_run.tf: the app authenticates /internal/* itself).
resource "google_cloud_run_v2_service_iam_member" "scheduler_invokes_backend" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}

# --- Deployer: push images, update the two services and the two jobs, act as the runtime SAs. Nothing project-wide.
resource "google_artifact_registry_repository_iam_member" "deployer_writes_images" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_service_iam_member" "deployer_backend" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_service_iam_member" "deployer_web" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_job_iam_member" "deployer_migrate" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.migrate.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_job_iam_member" "deployer_seed_admin" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.seed_admin.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

# The deploy preflight lists secret versions (metadata only; roles/secretmanager.viewer cannot read payloads) to refuse a deploy
# while a secret still holds the throwaway placeholder version 1.
resource "google_secret_manager_secret_iam_member" "deployer_lists_versions" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.key].secret_id
  role      = "roles/secretmanager.viewer"
  member    = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_service_account_iam_member" "deployer_acts_as_runtime" {
  for_each = {
    backend = google_service_account.backend.name
    web     = google_service_account.web.name
    migrate = google_service_account.migrate.name
  }

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}

# --- Planner: strictly read-only. Any branch or PR of the repo can run code as this identity (the workflow file comes from
# the PR head), so it gets no data access at all. CI runs `terraform plan -refresh=false -lock=false`: the plan is config vs the
# state file, so the only things read are the state object and the google_project data source.
#  * roles/browser: resourcemanager.projects.get/list only (no resource, bucket-object or secret access; deliberately NOT
#    roles/viewer, which includes legacy object read on buckets and would expose the resume PDFs).
#  * roles/serviceusage.serviceUsageConsumer: lets the provider bill API calls to the project.
# Full-refresh drift checks are run locally by the owner.
resource "google_project_iam_member" "planner" {
  for_each = toset([
    "roles/browser",
    "roles/serviceusage.serviceUsageConsumer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_planner.email}"
}

# Read-only on the state bucket (state and its versions). The plan runs with -lock=false, so no object write is needed:
# a PR branch can neither overwrite nor delete state.
resource "google_storage_bucket_iam_member" "planner_state" {
  bucket = var.state_bucket
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.github_planner.email}"
}

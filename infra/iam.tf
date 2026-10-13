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

# --- Planner: read-only for PR plans. CI runs `terraform plan -refresh=false` (diff of config vs state), so it does not need to
# read secret payloads or IAM policies; full-refresh drift checks are run locally by the owner.
resource "google_project_iam_member" "planner" {
  for_each = toset([
    "roles/viewer",
    "roles/serviceusage.serviceUsageConsumer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_planner.email}"
}

# terraform plan takes a lock on the state, which is an object write.
resource "google_storage_bucket_iam_member" "planner_state" {
  bucket = var.state_bucket
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.github_planner.email}"
}

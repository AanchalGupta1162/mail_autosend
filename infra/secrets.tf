# Secret CONTAINERS only. Real values are added out-of-band so Terraform state never holds them:
#   printf '%s' "$VALUE" | gcloud secrets versions add mail-database-url --data-file=-
# See infra/README.md.

locals {
  secrets = {
    DATABASE_URL       = "mail-database-url"
    GMAIL_USER         = "mail-gmail-user"
    GMAIL_APP_PASSWORD = "mail-gmail-app-password"
    SESSION_SECRET     = "mail-session-secret"
    SIGNATURE_HTML     = "mail-signature-html"
    ADMIN_PASSWORD     = "mail-admin-password"
  }

  backend_secret_env = ["DATABASE_URL", "GMAIL_USER", "GMAIL_APP_PASSWORD", "SESSION_SECRET", "SIGNATURE_HTML"]
  migrate_secret_env = ["DATABASE_URL", "ADMIN_PASSWORD"]
}

resource "google_secret_manager_secret" "app" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = each.value

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.enabled]
}

# Throwaway version 1 so Cloud Run can resolve "latest" on the first apply. The value is a literal placeholder, never a
# credential. Terraform never touches the secret data again; real versions you add become "latest".
resource "google_secret_manager_secret_version" "placeholder" {
  for_each = var.seed_placeholder_secret_versions ? local.secrets : {}

  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = "PLACEHOLDER-replace-with-gcloud-secrets-versions-add"

  lifecycle {
    ignore_changes = [secret_data, enabled]
  }
}

resource "google_secret_manager_secret_iam_member" "backend" {
  for_each = toset(local.backend_secret_env)

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_secret_manager_secret_iam_member" "migrate" {
  for_each = toset(local.migrate_secret_env)

  project   = var.project_id
  secret_id = google_secret_manager_secret.app[each.value].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrate.email}"
}

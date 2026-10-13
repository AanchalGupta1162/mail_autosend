locals {
  # Cloud Run's deterministic service URL (https://<service>-<project number>.<region>.run.app). Computing it up front
  # avoids a self-reference (INTERNAL_AUDIENCE must equal the service's own URL) and a two-step bootstrap.
  backend_url = "https://mail-backend-${data.google_project.this.number}.${var.region}.run.app"
  web_url     = "https://mail-web-${data.google_project.this.number}.${var.region}.run.app"

  repo_path = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"

  # Everything below is config Terraform owns. CI replaces only the image (see lifecycle blocks).
  backend_env = merge(
    {
      NODE_ENV                       = "production"
      WORKER_MODE                    = "scheduled"
      INTERNAL_AUDIENCE              = local.backend_url
      INTERNAL_INVOKER_SA            = google_service_account.scheduler_invoker.email
      INTERNAL_TICK_DEADLINE_SECONDS = tostring(var.tick_deadline_seconds)
      SEND_WINDOW_ENFORCED           = "true"
      SWEEP_MAX_AGE_MINUTES          = tostring(var.sweep_max_age_minutes)
      MIGRATE_ON_START               = "false" # the mail-migrate job runs before every rollout
      RESUME_STORAGE                 = "gcs"
      RESUME_BUCKET                  = google_storage_bucket.resumes.name
      TRUST_PROXY                    = tostring(var.trust_proxy_hops)
      DRY_RUN                        = tostring(var.dry_run)
      DAILY_SEND_CAP                 = tostring(var.daily_send_cap)
      MAX_PER_TICK                   = tostring(var.max_per_tick)
    },
    var.from_name == "" ? {} : { FROM_NAME = var.from_name },
  )
}

resource "google_cloud_run_v2_service" "backend" {
  project             = var.project_id
  name                = "mail-backend"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.backend.email
    timeout                          = "900s"
    max_instance_request_concurrency = 4

    scaling {
      min_instance_count = 0
      max_instance_count = var.backend_max_instances
    }

    containers {
      image = var.placeholder_image

      # The container listens on $PORT (injected by Cloud Run from this value).
      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # CPU only while a request is open: /internal/* calls are request-bound
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.backend_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = toset(local.backend_secret_env)
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 12
        http_get {
          path = "/healthz"
        }
      }

      liveness_probe {
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 3
        http_get {
          path = "/healthz"
        }
      }
    }
  }

  # CI owns the image and the traffic split (no-traffic deploy, smoke test, shift, rollback). Terraform owns the rest.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].revision,
      traffic,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.placeholder,
    google_secret_manager_secret_iam_member.backend,
    google_storage_bucket_iam_member.backend_resumes,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  project             = var.project_id
  name                = "mail-web"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.web.email
    timeout                          = "60s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = 0
      max_instance_count = var.web_max_instances
    }

    containers {
      image = var.placeholder_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "BACKEND_URL" # read by proxy.ts at run time; the /api/* rewrite was baked in at build time by CI
        value = local.backend_url
      }

      startup_probe {
        initial_delay_seconds = 0
        period_seconds        = 5
        timeout_seconds       = 3
        failure_threshold     = 12
        http_get {
          path = "/login"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].revision,
      traffic,
      client,
      client_version,
    ]
  }
}

# The browser reaches both services anonymously: mail-web serves the UI, and its /api/* rewrite calls mail-backend without
# an IAM token. mail-backend authenticates callers itself (session + CSRF; /internal/* only accepts the scheduler's OIDC token).
# If the org policy blocks allUsers (domain restricted sharing), this is where the deploy will fail.
resource "google_cloud_run_v2_service_iam_member" "web_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Jobs: run to completion before each rollout (migrate) or once on demand (seed-admin) ---------------------
resource "google_cloud_run_v2_job" "migrate" {
  project             = var.project_id
  name                = "mail-migrate"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.migrate.email
      max_retries     = 0 # a failed migration must stop the deploy, not be retried blindly
      timeout         = "600s"

      containers {
        image   = var.placeholder_image
        command = ["node"]
        args    = ["src/db/migrate.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["DATABASE_URL"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.placeholder,
    google_secret_manager_secret_iam_member.migrate,
  ]
}

# Creates or resets the admin user (scripts/seedAdmin.js also applies pending migrations). Idempotent; run on demand:
#   gcloud run jobs execute mail-seed-admin --region asia-south1 --wait
resource "google_cloud_run_v2_job" "seed_admin" {
  project             = var.project_id
  name                = "mail-seed-admin"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.migrate.email
      max_retries     = 0
      timeout         = "300s"

      containers {
        image   = var.placeholder_image
        command = ["node"]
        args    = ["scripts/seedAdmin.js"]

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }

        env {
          name  = "ADMIN_USERNAME"
          value = var.admin_username
        }

        dynamic "env" {
          for_each = toset(local.migrate_secret_env)
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.app[env.value].secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_version.placeholder,
    google_secret_manager_secret_iam_member.migrate,
  ]
}

# Cloud Scheduler wakes the scale-to-zero backend. Postgres is the queue, so a missed wake-up is a delay, never a lost
# or duplicate send. Jobs are created PAUSED (var.scheduler_paused) and Terraform then ignores the paused flag, so
# `gcloud scheduler jobs pause|resume` is the operator's lever and an apply never fights it.

locals {
  scheduler_jobs = merge(
    {
      "send-window" = {
        schedule      = var.send_window_schedule
        path          = "/internal/tick"
        description   = "Send worker wake-up during the 9-10 AM IST window (app also enforces the window)"
        retry_count   = 1
        min_backoff   = "30s"
        max_backoff   = "120s"
        max_doublings = 1
      }
    },
    {
      for name, cron in var.reply_sweep_schedules : name => {
        schedule      = cron
        path          = "/internal/sweep"
        description   = "Reply sweep (IMAP)"
        retry_count   = 3
        min_backoff   = "60s"
        max_backoff   = "600s"
        max_doublings = 3
      }
    },
  )
}

resource "google_cloud_scheduler_job" "jobs" {
  for_each = local.scheduler_jobs

  project          = var.project_id
  region           = var.region
  name             = each.key
  description      = each.value.description
  schedule         = each.value.schedule
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "600s"
  paused           = var.scheduler_paused

  retry_config {
    retry_count          = each.value.retry_count
    min_backoff_duration = each.value.min_backoff
    max_backoff_duration = each.value.max_backoff
    max_doublings        = each.value.max_doublings
  }

  http_target {
    http_method = "POST"
    uri         = "${local.backend_url}${each.value.path}"
    headers = {
      "Content-Type" = "application/json"
    }
    body = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.scheduler_invoker.email
      audience              = local.backend_url
    }
  }

  lifecycle {
    ignore_changes = [paused]
  }

  depends_on = [
    google_project_service.enabled,
    google_cloud_run_v2_service_iam_member.scheduler_invokes_backend,
  ]
}

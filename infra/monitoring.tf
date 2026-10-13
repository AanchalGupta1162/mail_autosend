resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "mail-autosender alerts"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.enabled]
}

locals {
  channels = [google_monitoring_notification_channel.email.id]

  backend_logs = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${google_cloud_run_v2_service.backend.name}\""
}

# (a) 5xx burst on either service.
resource "google_monitoring_alert_policy" "http_5xx" {
  project               = var.project_id
  display_name          = "mail-autosender: 5xx burst"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "More than 5 server errors in 5 minutes"
    condition_threshold {
      filter = join(" AND ", [
        "resource.type=\"cloud_run_revision\"",
        "metric.type=\"run.googleapis.com/request_count\"",
        "metric.labels.response_code_class=\"5xx\"",
        "(resource.labels.service_name=\"${google_cloud_run_v2_service.backend.name}\" OR resource.labels.service_name=\"${google_cloud_run_v2_service.web.name}\")",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.labels.service_name"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "mail-backend or mail-web is returning 5xx. Check Cloud Run logs for the service; if a deploy just happened, see docs/deploy.md (rollback)."
  }
}

# (b) The backend logged an error: covers a failing /internal/tick or /internal/sweep (IMAP connect, SMTP/DB errors).
resource "google_monitoring_alert_policy" "backend_errors" {
  project               = var.project_id
  display_name          = "mail-autosender: backend logged an error"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "severity>=ERROR in mail-backend logs"
    condition_matched_log {
      filter = "${local.backend_logs} AND severity>=ERROR"
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "604800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "mail-backend logged severity ERROR (tick, reply sweep, or an unhandled request error). Open Logs Explorer filtered to the service. Messages are never sent twice: Postgres is the queue."
  }
}

# (c) Cloud Scheduler job failed. Scheduler logs one ERROR per failed ATTEMPT, including attempts its own retry then fixes, so a
# single error is not an incident. Every job retries (send-window once, sweeps three times), so a job that is really failing
# logs at least two errors within minutes. The metric counts attempt errors per job and the policy fires on more than one in
# 30 minutes. Limit: an alignment bucket boundary can split two errors into 1+1 and hide that occurrence; the backend ERROR
# alert (b) and the send-attention alert (d) cover that case when the backend itself was reached.
resource "google_logging_metric" "scheduler_attempt_errors" {
  project = var.project_id
  name    = "mail_scheduler_attempt_errors"
  filter  = "resource.type=\"cloud_scheduler_job\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "scheduler_failures" {
  project               = var.project_id
  display_name          = "mail-autosender: Cloud Scheduler job failed"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "More than one failed attempt of one scheduler job in 30 minutes"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.scheduler_attempt_errors.name}\" AND resource.type=\"cloud_scheduler_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "0s"

      aggregations {
        alignment_period     = "1800s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.job_id"]
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "604800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "A Cloud Scheduler job failed repeatedly (a single failed attempt that a retry fixes does not alert). Check the job's logs (gcloud scheduler jobs describe) and the matching backend request in Cloud Run logs (401/403 usually means OIDC audience or invoker SA mismatch)."
  }
}

# (d) The send worker held, failed, or flagged messages for review, or is paused by a systemic hold. The app logs this on
# every /internal/tick (event=internal_tick, summary counters, reason=paused while send_hold is active).
resource "google_monitoring_alert_policy" "send_attention" {
  project               = var.project_id
  display_name          = "mail-autosender: sending needs attention (hold / needs_review / failed)"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "internal_tick reported held, needsReview, failed or paused"
    condition_matched_log {
      filter = join(" AND ", [
        local.backend_logs,
        "jsonPayload.event=\"internal_tick\"",
        "(jsonPayload.held>0 OR jsonPayload.needsReview>0 OR jsonPayload.failed>0 OR jsonPayload.reason=\"paused\")",
      ])
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "604800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "A send hold is active or messages are in needs_review/failed. The dashboard shows the hold banner. Typical causes: rejected Gmail app password, missing resume or signature. See docs/deploy.md."
  }
}

# (e) No successful reply sweep for ~24 hours. Counts /internal/sweep completions the app itself rates healthy: the
# `internal_sweep` log line carries ok (no fatal error, row errors within tolerance, at least one check completed when there
# were candidates). Skipped sweeps and errors have no ok=true and are not counted.
resource "google_logging_metric" "sweep_success" {
  project = var.project_id
  name    = "mail_sweep_success"
  filter = join(" AND ", [
    local.backend_logs,
    "jsonPayload.event=\"internal_sweep\"",
    "jsonPayload.ok=true",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# Cloud Monitoring absence conditions are capped at 24h, so this fires after 23.5h without a success (one full day with
# five scheduled sweeps; the longest normal gap is about 13h overnight). Off by default: dry-run sweeps are skipped.
resource "google_monitoring_alert_policy" "sweep_stale" {
  project               = var.project_id
  display_name          = "mail-autosender: no successful reply sweep in ~24h"
  combiner              = "OR"
  enabled               = var.sweep_alert_enabled
  notification_channels = local.channels

  conditions {
    display_name = "No successful sweep"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.sweep_success.name}\" AND resource.type=\"cloud_run_revision\""
      duration = "84600s"

      aggregations {
        alignment_period   = "3600s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Replies are not being detected. Follow-ups are held while the last sweep is stale, so nothing is sent blindly. Check the reply-sweep scheduler jobs, Gmail IMAP access and GMAIL_APP_PASSWORD."
  }
}

# (f) Uptime check on the public login page. Every 15 minutes keeps cost trivial; it only touches mail-web.
resource "google_monitoring_uptime_check_config" "web_login" {
  project      = var.project_id
  display_name = "mail-web /login"
  period       = "900s"
  timeout      = "10s"

  http_check {
    path           = "/login"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = trimprefix(local.web_url, "https://")
    }
  }

  depends_on = [google_project_service.enabled]
}

resource "google_monitoring_alert_policy" "web_down" {
  project               = var.project_id
  display_name          = "mail-autosender: mail-web /login is down"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "Uptime check failing from 2+ locations"
    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "metric.labels.check_id=\"${google_monitoring_uptime_check_config.web_login.uptime_check_id}\"",
        "resource.type=\"uptime_url\"",
      ])
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "0s"

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = "The dashboard login page is not answering. Check mail-web in Cloud Run and the latest deploy; see docs/deploy.md (rollback)."
  }
}

# (g) Budget alert on the project.
resource "google_billing_budget" "project" {
  count = var.billing_account_id == "" ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "mail-autosender monthly budget"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 1.0
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = local.channels
    disable_default_iam_recipients   = false
  }

  depends_on = [google_project_service.enabled]
}

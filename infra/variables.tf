variable "project_id" {
  description = "GCP project that hosts everything."
  type        = string
  default     = "codecell-vesit"
}

variable "region" {
  description = "Region for Cloud Run, Scheduler, Artifact Registry and secret replicas (Mumbai)."
  type        = string
  default     = "asia-south1"
}

variable "state_bucket" {
  description = "Existing Terraform state bucket (created by hand). Only used to grant the plan identity access."
  type        = string
  default     = "codecell-vesit-tfstate"
}

variable "github_repo" {
  description = "GitHub repository (owner/name) allowed to authenticate through Workload Identity Federation."
  type        = string
  default     = "Harshavardhan-28/mail_autosend"
}

variable "github_repository_id" {
  description = "Numeric, immutable GitHub repository id (`gh api repos/OWNER/NAME --jq .id`). Pinned in the WIF conditions so a renamed or recreated repo with the same name cannot authenticate."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be the numeric repository id."
  }
}

variable "github_branch" {
  description = "The only branch whose workflows may impersonate the deployer service account."
  type        = string
  default     = "main"
}

variable "resume_bucket_name" {
  description = "Existing resume bucket (import it, do not recreate)."
  type        = string
  default     = "mail-autosender-resumes-codecell"
}

variable "alert_email" {
  description = "Address that receives alert and budget emails."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "billing_account_id" {
  description = "Billing account id (XXXXXX-XXXXXX-XXXXXX) for the budget alert. Empty = no budget resource."
  type        = string
  default     = ""
}

variable "budget_amount_usd" {
  description = "Monthly budget in whole USD. Alerts fire at 50% and 100% (and forecasted 100%)."
  type        = number
  default     = 10
}

variable "scheduler_paused" {
  description = <<-EOT
    Initial state of the Cloud Scheduler jobs at CREATION. After that Terraform ignores the paused flag,
    so an emergency `gcloud scheduler jobs pause` is never reverted by a later apply.
  EOT
  type        = bool
  default     = true
}

variable "sweep_alert_enabled" {
  description = "Enable the 'no successful reply sweep in ~24h' alert. Leave false until real sweeps have run once (dry-run sweeps are skipped, which would page you)."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Cloud Run service/job deletion protection. Set false only to tear the stack down."
  type        = bool
  default     = true
}

variable "seed_placeholder_secret_versions" {
  description = <<-EOT
    Create a throwaway version 1 ("placeholder") in each secret so Cloud Run can start before real values exist.
    Real values are added with `gcloud secrets versions add`; "latest" then resolves to them.
  EOT
  type        = bool
  default     = true
}

# --- Images (CI owns them after the first apply) -----------------------------------------------------------
variable "placeholder_image" {
  description = "Public image used only for the first apply. CI deploys the real SHA-tagged images and Terraform ignores image changes."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

# --- Application settings (Terraform owns config; CI owns images) ------------------------------------------
variable "dry_run" {
  description = "DRY_RUN for the backend. true records sends without contacting Gmail. Flip to false only after the first-deploy checklist."
  type        = bool
  default     = true
}

variable "admin_username" {
  description = "ADMIN_USERNAME for the one-off seed-admin job (the password lives in Secret Manager)."
  type        = string
  default     = "admin"
}

variable "from_name" {
  description = "FROM_NAME display name recipients see."
  type        = string
  default     = ""
}

variable "daily_send_cap" {
  description = "DAILY_SEND_CAP (real emails per rolling 24h)."
  type        = number
  default     = 100
}

variable "max_per_tick" {
  description = "MAX_PER_TICK (messages claimed per worker tick)."
  type        = number
  default     = 5
}

variable "sweep_max_age_minutes" {
  description = "SWEEP_MAX_AGE_MINUTES: follow-ups wait while the last good reply sweep is older than this."
  type        = number
  default     = 90
}

variable "tick_deadline_seconds" {
  description = "INTERNAL_TICK_DEADLINE_SECONDS: longest one /internal/tick call keeps sending (must stay below the 900s Cloud Run timeout and well below the 600s scheduler attempt deadline: after the deadline one more send can still finish, up to 90s, so 480 + 90 stays under 600)."
  type        = number
  default     = 480
}

variable "trust_proxy_hops" {
  description = <<-EOT
    TRUST_PROXY for the backend: number of proxies that append to X-Forwarded-For in front of Express.
    Browser -> mail-web (Cloud Run front end + Next rewrite) -> mail-backend (Cloud Run front end) is assumed to be 2, but 3 is
    plausible. Verifying it is a MANDATORY first-deploy step (docs/deploy.md): too low puts every user (and an attacker) in
    one rate-limit/lockout bucket, too high lets clients spoof their IP.
  EOT
  type        = number
  default     = 2

  validation {
    condition     = var.trust_proxy_hops >= 0 && var.trust_proxy_hops <= 5
    error_message = "trust_proxy_hops must be between 0 and 5."
  }
}

variable "backend_max_instances" {
  description = "Must stay 1: the send worker and the reply sweep are single-writer by design."
  type        = number
  default     = 1

  validation {
    condition     = var.backend_max_instances == 1
    error_message = "mail-backend must run at most one instance (single-writer worker)."
  }
}

variable "web_max_instances" {
  description = "Upper bound for mail-web instances."
  type        = number
  default     = 3
}

variable "reply_sweep_schedules" {
  description = "Reply sweep cron schedules (Asia/Kolkata). The 08:50 one lets follow-ups through right before the send window."
  type        = map(string)
  default = {
    "reply-sweep-0850" = "50 8 * * *"
    "reply-sweep-1000" = "0 10 * * *"
    "reply-sweep-1320" = "20 13 * * *"
    "reply-sweep-1640" = "40 16 * * *"
    "reply-sweep-2000" = "0 20 * * *"
  }
}

variable "send_window_schedule" {
  description = "Cron for /internal/tick (Asia/Kolkata). The app additionally enforces the send window itself, so if the Settings window changes this cron must change too or nothing sends."
  type        = string
  default     = "*/5 9 * * *"
}

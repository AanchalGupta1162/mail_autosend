terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # Remote state. Backend blocks cannot use variables, so the bucket is literal.
  # The bucket is created once by hand (see infra/README.md) and is NOT managed by this configuration.
  backend "gcs" {
    bucket = "codecell-vesit-tfstate"
    prefix = "mail-autosender/infra"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # Bill API calls (monitoring, billing budgets) to this project instead of the caller's gcloud quota project.
  user_project_override = true
  billing_project       = var.project_id
}

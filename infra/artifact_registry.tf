resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = "mail-autosender"
  description   = "mail-backend and mail-web images, tagged with the git commit SHA"
  format        = "DOCKER"

  docker_config {
    immutable_tags = false # CI also moves a convenience tag; SHA tags are never rewritten by the pipeline.
  }

  cleanup_policy_dry_run = false

  # Keep the 10 newest versions of each package and anything tagged as a release; drop the rest after 30 days.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "keep-releases"
    action = "KEEP"
    condition {
      tag_state    = "TAGGED"
      tag_prefixes = ["release-", "v"]
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s"
    }
  }

  # Vulnerability scanning on push comes from containerscanning.googleapis.com (enabled in apis.tf).
  depends_on = [google_project_service.enabled]
}

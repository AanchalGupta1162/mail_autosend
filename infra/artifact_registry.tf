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

  # KEEP policies always win over DELETE. Pipeline images are pushed without sbom/provenance attestations (CI scans them with
  # trivy), so one build is one version per package and keep_count is a real count of builds. Deleting by age alone could
  # remove an image a quiet project still serves or that docs/deploy.md rollback needs, so the age cutoff is long (180 days)
  # and the newest 30 builds of each package are never deleted regardless of age. To pin an image forever, tag it
  # `release-<anything>` (see docs/deploy.md).
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 30
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
      older_than = "15552000s"
    }
  }

  # Vulnerability scanning on push comes from containerscanning.googleapis.com (enabled in apis.tf).
  depends_on = [google_project_service.enabled]
}

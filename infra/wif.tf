# GitHub Actions authenticates with short-lived OIDC tokens: no service account keys exist anywhere.
#
#  provider github-main: only workflows on refs/heads/<branch> of the repo (pinned by immutable repository id, so a renamed or
#                        deleted-and-recreated repo under the same name cannot authenticate). The deployer SA is bound to
#                        this ref AND to the deploy.yml workflow file alone.
#  provider github-pr:   any ref of the repo (pull_request runs). Bound only to the read-only planner SA.
#
# Never add a pull_request_target workflow: it runs with ref refs/heads/main and would satisfy the ref condition. The
# job_workflow_ref binding below is what keeps such a workflow (or any other workflow file on main) from becoming the deployer.

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github_main" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-main"
  display_name                       = "GitHub ${var.github_branch}"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.ref"              = "assertion.ref"
    "attribute.repository_id"    = "assertion.repository_id"
    "attribute.job_workflow_ref" = "assertion.job_workflow_ref"
  }

  attribute_condition = "assertion.repository == '${var.github_repo}' && assertion.repository_id == '${var.github_repository_id}' && assertion.ref == 'refs/heads/${var.github_branch}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_iam_workload_identity_pool_provider" "github_pr" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-pr"
  display_name                       = "GitHub pull requests (plan only)"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.ref"           = "assertion.ref"
    "attribute.repository_id" = "assertion.repository_id"
  }

  attribute_condition = "assertion.repository == '${var.github_repo}' && assertion.repository_id == '${var.github_repository_id}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Only a token minted by deploy.yml on exactly main (repo and ref are pinned in the provider condition) can become the
# deployer, whichever provider minted it. A new workflow file merged to main cannot.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.job_workflow_ref/${var.github_repo}/.github/workflows/deploy.yml@refs/heads/${var.github_branch}"
}

resource "google_service_account_iam_member" "planner_wif" {
  service_account_id = google_service_account.github_planner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

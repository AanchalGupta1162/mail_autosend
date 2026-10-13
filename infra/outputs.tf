output "wif_provider" {
  description = "GitHub repo variable WIF_PROVIDER (deploy workflow)."
  value       = google_iam_workload_identity_pool_provider.github_main.name
}

output "wif_provider_plan" {
  description = "GitHub repo variable WIF_PROVIDER_PLAN (terraform-plan workflow)."
  value       = google_iam_workload_identity_pool_provider.github_pr.name
}

output "deployer_service_account" {
  description = "GitHub repo variable DEPLOY_SA."
  value       = google_service_account.github_deployer.email
}

output "planner_service_account" {
  description = "GitHub repo variable PLAN_SA."
  value       = google_service_account.github_planner.email
}

output "backend_url" {
  value = local.backend_url
}

output "web_url" {
  value = local.web_url
}

output "artifact_registry" {
  description = "Image path prefix: <prefix>/mail-backend:<sha>, <prefix>/mail-web:<sha>."
  value       = local.repo_path
}

output "scheduler_invoker_service_account" {
  value = google_service_account.scheduler_invoker.email
}

output "secret_names" {
  description = "Secret Manager ids that need real values (gcloud secrets versions add)."
  value       = values(local.secrets)
}

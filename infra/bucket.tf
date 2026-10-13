# The resume bucket already exists and holds real data. Import it, never recreate it:
#   terraform import google_storage_bucket.resumes codecell-vesit/mail-autosender-resumes-codecell
# Then run `terraform plan` and reconcile any difference with `gcloud storage buckets describe gs://<bucket>`
# (location, storage class) BEFORE applying. prevent_destroy blocks accidental deletion.
resource "google_storage_bucket" "resumes" {
  project  = var.project_id
  name     = var.resume_bucket_name
  location = "ASIA-SOUTH1"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.enabled]
}

# The backend is the only principal that can read or write resumes.
resource "google_storage_bucket_iam_member" "backend_resumes" {
  bucket = google_storage_bucket.resumes.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.backend.email}"
}

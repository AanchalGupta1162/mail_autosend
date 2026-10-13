-- Resume library. The PDF bytes live in object storage (GCS or a local folder); this table holds
-- the metadata. Rows are soft-deleted so scheduled/sent messages stay explainable.
CREATE TABLE IF NOT EXISTS resumes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  file_name text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  generation text NOT NULL,
  size_bytes int NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS resumes_one_default_idx ON resumes ((true)) WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS resumes_live_name_idx ON resumes (lower(display_name)) WHERE deleted_at IS NULL;

-- Choice: a default per batch and an optional per-contact override (nullable = "not chosen").
ALTER TABLE batches ADD COLUMN IF NOT EXISTS resume_id uuid REFERENCES resumes(id);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS resume_id uuid REFERENCES resumes(id);
-- Snapshot taken when a message is scheduled: what the worker sends, whatever happens to the library later.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS resume_id uuid REFERENCES resumes(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS resume_generation text;
CREATE INDEX IF NOT EXISTS messages_resume_idx ON messages (resume_id) WHERE resume_id IS NOT NULL;

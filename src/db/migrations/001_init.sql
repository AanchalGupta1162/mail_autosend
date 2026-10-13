CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash text NOT NULL,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  original_filename text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  company text NOT NULL,
  role text NOT NULL,
  person text NOT NULL,
  email text NOT NULL,
  subject text NOT NULL,
  mail_text text NOT NULL,
  followup_text text,
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded','scheduled','sent','replied','bounced','opted_out','failed')),
  followup_requested boolean NOT NULL DEFAULT false,
  followup_delay_days int NOT NULL DEFAULT 7 CHECK (followup_delay_days BETWEEN 1 AND 60),
  replied_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_batch_email_idx ON contacts (batch_id, lower(email));
CREATE INDEX contacts_status_idx ON contacts (status);
CREATE INDEX contacts_email_idx ON contacts (lower(email));

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initial','followup')),
  state text NOT NULL
    CHECK (state IN ('scheduled','sending','sent','failed','cancelled','needs_review')),
  scheduled_for timestamptz NOT NULL,
  message_id text,
  sent_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  error text,
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_one_live_per_kind_idx ON messages (contact_id, kind) WHERE state <> 'cancelled';
CREATE INDEX messages_state_scheduled_idx ON messages (state, scheduled_for);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  type text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_at_idx ON events (at DESC);

CREATE TABLE suppressions (
  email text PRIMARY KEY CHECK (email = lower(email)),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

INSERT INTO settings (key, value) VALUES (
  'followup_template',
  jsonb_build_object(
    'subject', 'Re: {{subject}}',
    'body', E'Hi {{firstName}},\n\nJust following up on my note about the {{role}} role at {{company}}. Happy to share anything that would help.\n\nBest,\nHarshavardhan Khamkar'
  )
);

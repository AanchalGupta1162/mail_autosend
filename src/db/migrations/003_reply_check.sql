-- Reply sweep fairness: contacts are checked least-recently-checked first so none starve.
ALTER TABLE contacts ADD COLUMN last_reply_check_at timestamptz;
CREATE INDEX contacts_reply_check_idx ON contacts (last_reply_check_at NULLS FIRST) WHERE status = 'sent';

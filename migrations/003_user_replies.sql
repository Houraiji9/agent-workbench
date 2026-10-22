CREATE TABLE IF NOT EXISTS user_replies (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  question_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_replies_run ON user_replies(run_id);

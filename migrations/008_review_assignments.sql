CREATE TABLE IF NOT EXISTS review_assignments (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_assignments_run ON review_assignments(run_id);

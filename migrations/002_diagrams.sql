CREATE TABLE IF NOT EXISTS diagrams (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  data TEXT NOT NULL
);

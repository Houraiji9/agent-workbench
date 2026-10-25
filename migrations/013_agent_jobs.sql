CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_run ON agent_jobs(run_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_request ON agent_jobs(json_extract(data,'$.request_id'));

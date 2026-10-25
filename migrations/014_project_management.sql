CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, data TEXT NOT NULL, run_id TEXT);
CREATE TABLE IF NOT EXISTS project_files (id TEXT PRIMARY KEY, data TEXT NOT NULL, project_id TEXT);
CREATE TABLE IF NOT EXISTS file_moves (id TEXT PRIMARY KEY, data TEXT NOT NULL, project_id TEXT, file_id TEXT);
CREATE TABLE IF NOT EXISTS delegations (id TEXT PRIMARY KEY, data TEXT NOT NULL, run_id TEXT);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_events(run_id);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_file_moves_project ON file_moves(project_id);
CREATE INDEX IF NOT EXISTS idx_delegations_run ON delegations(run_id);

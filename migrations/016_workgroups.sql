CREATE TABLE IF NOT EXISTS workgroup_rooms(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workgroup_members(id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES workgroup_rooms(id), agent_id TEXT NOT NULL REFERENCES agents(id), data TEXT NOT NULL, UNIQUE(room_id,agent_id));
CREATE TABLE IF NOT EXISTS workgroup_messages(id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES workgroup_rooms(id), seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(room_id,seq));
CREATE TABLE IF NOT EXISTS workgroup_jobs(id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES workgroup_rooms(id), member_id TEXT NOT NULL REFERENCES workgroup_members(id), status TEXT NOT NULL, token_hash TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workgroup_inbox(member_id TEXT NOT NULL REFERENCES workgroup_members(id), seq INTEGER NOT NULL, message_id TEXT NOT NULL REFERENCES workgroup_messages(id), PRIMARY KEY(member_id,seq));
CREATE TABLE IF NOT EXISTS workgroup_requests(scope_key TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workgroup_rooms_project ON workgroup_rooms(project_id);
CREATE INDEX IF NOT EXISTS workgroup_jobs_queue ON workgroup_jobs(status,member_id);
CREATE UNIQUE INDEX IF NOT EXISTS workgroup_jobs_token ON workgroup_jobs(token_hash) WHERE token_hash IS NOT NULL;

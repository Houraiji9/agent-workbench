CREATE TABLE IF NOT EXISTS api_agent_configs(agent_id TEXT PRIMARY KEY REFERENCES agents(id), data TEXT NOT NULL, secret_cipher TEXT);
CREATE TABLE IF NOT EXISTS api_agent_sessions(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), room_id TEXT NOT NULL REFERENCES workgroup_rooms(id), member_id TEXT NOT NULL REFERENCES workgroup_members(id), config_version INTEGER NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, state_cipher TEXT);
CREATE INDEX IF NOT EXISTS api_agent_sessions_member ON api_agent_sessions(room_id,member_id,config_version);

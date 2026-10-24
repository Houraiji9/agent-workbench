-- Agent-prepared decisions are inert until confirmed in the user's page session.
CREATE TABLE IF NOT EXISTS user_decisions (id TEXT PRIMARY KEY, data TEXT NOT NULL);

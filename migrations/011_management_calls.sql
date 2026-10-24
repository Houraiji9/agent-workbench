-- Durable idempotency and provenance for actions delegated by the local user.
CREATE TABLE IF NOT EXISTS management_calls (id TEXT PRIMARY KEY, data TEXT NOT NULL);

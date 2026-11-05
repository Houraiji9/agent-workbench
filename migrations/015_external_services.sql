-- External service credentials are DPAPI ciphertext, never configuration JSON.
CREATE TABLE IF NOT EXISTS external_connections(id TEXT PRIMARY KEY, data TEXT NOT NULL, secret_cipher TEXT);
CREATE TABLE IF NOT EXISTS external_invocations(id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS external_grants(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, data TEXT NOT NULL);

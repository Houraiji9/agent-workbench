CREATE TABLE IF NOT EXISTS quota_definitions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS quota_definition_source ON quota_definitions(json_extract(data,'$.source_ref')) WHERE json_extract(data,'$.source_ref') IS NOT NULL;

-- Only remove the retired upstream subscription mirror. User-maintained entries stay.
DELETE FROM subscriptions WHERE json_extract(data,'$.source')='token_monitor';
UPDATE integrations SET data=json_set(data,'$.error',NULL)
WHERE id='tokenMonitor' AND json_extract(data,'$.error')='用量已读；订阅接口不可用或契约不匹配';

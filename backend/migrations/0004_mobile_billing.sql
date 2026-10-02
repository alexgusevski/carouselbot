ALTER TABLE subscriptions ADD COLUMN provider TEXT NOT NULL DEFAULT 'polar';
ALTER TABLE subscriptions ADD COLUMN store TEXT;
CREATE INDEX subscriptions_provider_user ON subscriptions(user_id,provider);
CREATE TABLE deleted_accounts (
  user_id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

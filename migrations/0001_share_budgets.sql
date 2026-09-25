-- Each batch reserves the global and client budgets together. A failed CHECK
-- rolls the entire batch back, including the other counter and cleanup.
CREATE TABLE share_budgets (
  scope TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  max_count INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  PRIMARY KEY (scope, window),
  CONSTRAINT share_budget_exceeded CHECK (count <= max_count AND bytes <= max_bytes)
);
CREATE INDEX share_budgets_expiry ON share_budgets(window);
CREATE TABLE share_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO share_settings VALUES ('signing_key', lower(hex(randomblob(32))));

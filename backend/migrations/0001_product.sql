PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  document TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id,id)
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX assets_user ON assets(user_id);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_user ON subscriptions(user_id);
CREATE TABLE allowances (
  user_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  allowance INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id,period_start)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  attachments TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  stopped INTEGER NOT NULL DEFAULT 0,
  period_start INTEGER NOT NULL,
  budget INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id,request_id),
  FOREIGN KEY(user_id,project_id) REFERENCES projects(user_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX jobs_active_project ON jobs(user_id,project_id) WHERE status IN ('queued','running');
CREATE INDEX jobs_project ON jobs(user_id,project_id,created_at);
CREATE TABLE job_events (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,id)
);
CREATE INDEX job_events_time ON job_events(job_id,created_at);
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

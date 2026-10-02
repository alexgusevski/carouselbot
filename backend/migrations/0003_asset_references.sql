ALTER TABLE projects ADD COLUMN save_token TEXT;
CREATE UNIQUE INDEX assets_tenant_id ON assets(id,user_id);
CREATE TABLE project_assets (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY(user_id,project_id,asset_id),
  FOREIGN KEY(user_id,project_id) REFERENCES projects(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(asset_id,user_id) REFERENCES assets(id,user_id) ON DELETE RESTRICT
);
CREATE INDEX project_assets_asset ON project_assets(asset_id);
CREATE TABLE job_assets (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY(job_id,asset_id),
  FOREIGN KEY(asset_id,user_id) REFERENCES assets(id,user_id) ON DELETE RESTRICT
);
CREATE INDEX job_assets_asset ON job_assets(asset_id);
CREATE TABLE asset_deletions (
  object_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

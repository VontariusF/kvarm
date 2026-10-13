-- Retry-then-classify for flaky required runner checks (architecture §0.3).
-- A failed required runner check gets exactly one second attempt on the
-- same tree: a new check run (attempt 2) whose `retry_of` names the failed
-- run, executed by the same ci_jobs row requeued under a new generation.
-- A pass on attempt 2 records a flake; quarantine makes a check neutral and
-- non-required until it is restored or expires. Additive only.

ALTER TABLE check_runs ADD COLUMN retry_of TEXT;

-- At most one retry per failed run, and the reverse lookup that keeps a
-- superseded runner-owned attempt out of external PATCH updates.
CREATE UNIQUE INDEX idx_checks_retry_of ON check_runs(retry_of) WHERE retry_of IS NOT NULL;

CREATE TABLE check_flakes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  change_set_id TEXT,
  failed_run_id TEXT NOT NULL,
  passed_run_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_check_flakes_newest ON check_flakes(repo_id, created_at DESC, id DESC);
CREATE INDEX idx_check_flakes_name_newest ON check_flakes(repo_id, name, created_at DESC, id DESC);

-- One row per quarantined check name. Every quarantine expires; a row past
-- `expires_at` counts as restored wherever quarantine is read.
CREATE TABLE check_quarantines (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  reason TEXT,
  quarantined_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, name)
);

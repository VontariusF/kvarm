-- Bounded reads for the review inbox (services/reviewInbox.ts, architecture §10).
-- The inbox merges the newest live changes of up to 100 repositories under a
-- (created_at, id) cursor; without an index in that order every live change of
-- every repository is read and sorted on each page. Drafts never wait for a
-- review, so they stay out of the index.
CREATE INDEX idx_cs_live_created ON change_sets(repo_id, created_at, id)
  WHERE state IN ('open', 'conflicted') AND merge_policy != 'draft';

-- The repositories of the organizations a viewer administers, found from the
-- membership instead of a scan of every repository.
CREATE INDEX idx_repos_owner_org ON repos(owner_org_id) WHERE owner_org_id IS NOT NULL;

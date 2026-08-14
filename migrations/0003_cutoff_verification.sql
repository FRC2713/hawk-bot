-- Reaction Cutoff Verification. See CONTEXT.md — a failed verification
-- blocks deletion/finalization rather than proceeding anyway; this column
-- is what lets the scheduler recognize and skip a failed Event on every
-- later tick until a HawkBot Admin manually retries it.
ALTER TABLE events ADD COLUMN verification_failed_at TEXT;

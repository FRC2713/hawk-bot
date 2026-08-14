-- OAuth installations. One row per workspace, written when an admin installs
-- the app. `payload_enc` is the whole Bolt Installation object, encrypted —
-- it carries the bot token, which can post as Hawk Bot anywhere it is invited.
--
-- Hawk Bot asks for no user tokens: everything it does, it does as itself.
-- That is the difference from hawk-mod, and the reason this table has no
-- per-person rows.
CREATE TABLE installations (
  id            INTEGER PRIMARY KEY,
  team_id       TEXT NOT NULL,
  enterprise_id TEXT,
  payload_enc   TEXT NOT NULL,
  scopes        TEXT,
  installed_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  revoked_at    TEXT,
  UNIQUE (team_id)
);

-- Operator-set configuration that belongs to the workspace rather than to the
-- host: which channel announcements go to, and so on. Keys are declared in
-- src/domain/settings.ts, not invented at write time — an unknown key here is
-- a typo that reads as "the feature is off".
--
-- Anything that is a *credential* stays in the environment. This table is
-- readable by anyone who can read the volume.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  set_by     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

import { decrypt, encrypt } from "../crypto.js";
import type { SettingKey } from "../domain/settings.js";
import { db } from "./client.js";

const nowIso = () => new Date().toISOString();

/* ----------------------------------------------------------- installations */

export type StoredInstallation = {
  teamId: string;
  enterpriseId: string | null;
  payload: unknown;
  scopes: string | null;
  installedAt: string;
  updatedAt: string;
};

type InstallationRow = {
  team_id: string;
  enterprise_id: string | null;
  payload_enc: string;
  scopes: string | null;
  installed_at: string;
  updated_at: string;
};

export function saveInstallation(args: {
  teamId: string;
  enterpriseId?: string | null;
  payload: unknown;
  scopes?: string | null;
}): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO installations (team_id, enterprise_id, payload_enc, scopes,
                                  installed_at, updated_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (team_id) DO UPDATE SET
         enterprise_id = excluded.enterprise_id,
         payload_enc   = excluded.payload_enc,
         scopes        = excluded.scopes,
         updated_at    = excluded.updated_at,
         revoked_at    = NULL`
    )
    .run(
      args.teamId,
      args.enterpriseId ?? null,
      encrypt(JSON.stringify(args.payload)),
      args.scopes ?? null,
      now,
      now
    );
}

export function getInstallation(
  teamId: string
): StoredInstallation | undefined {
  const row = db()
    .prepare<[string], InstallationRow>(
      "SELECT * FROM installations WHERE team_id = ? AND revoked_at IS NULL"
    )
    .get(teamId);
  if (!row) return undefined;
  return {
    teamId: row.team_id,
    enterpriseId: row.enterprise_id,
    payload: JSON.parse(decrypt(row.payload_enc)),
    scopes: row.scopes,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Marked rather than deleted. "Uninstalled on the 3rd" and "was never
 * installed" are different answers to the same support question, and only one
 * of them is a person's decision.
 */
export function revokeInstallation(teamId: string): void {
  db()
    .prepare(
      "UPDATE installations SET revoked_at = ?, updated_at = ? WHERE team_id = ?"
    )
    .run(nowIso(), nowIso(), teamId);
}

export function anyInstallation(): StoredInstallation | undefined {
  const row = db()
    .prepare<[], InstallationRow>(
      "SELECT * FROM installations WHERE revoked_at IS NULL LIMIT 1"
    )
    .get();
  return row ? getInstallation(row.team_id) : undefined;
}

/* ---------------------------------------------------------------- settings */

export type SettingRow = {
  key: string;
  value: string;
  set_by: string;
  updated_at: string;
};

export function getSetting(key: SettingKey): string | undefined {
  return db()
    .prepare<[string], { value: string }>(
      "SELECT value FROM settings WHERE key = ?"
    )
    .get(key)?.value;
}

export function setSetting(
  key: SettingKey,
  value: string,
  setBy: string
): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO settings (key, value, set_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value      = excluded.value,
         set_by     = excluded.set_by,
         updated_at = excluded.updated_at`
    )
    .run(key, value, setBy, now);
}

export function listSettings(): SettingRow[] {
  return db()
    .prepare<[], SettingRow>("SELECT * FROM settings ORDER BY key")
    .all();
}

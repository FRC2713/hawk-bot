import type { WebClient } from "@slack/web-api";
import { clearSetting, setSetting } from "../db/repo.js";
import type { SettingKey } from "../domain/settings.js";
import { checkSetting, findSetting, SETTINGS } from "../domain/settings.js";

/**
 * The one write path for workspace settings, shared by `/hawkbot config set`
 * and the web configuration page so the two surfaces cannot drift: same
 * validation (domain/settings.ts), same usergroup handle→id resolution, same
 * stored value. Callers format the outcome for their own medium — Slack
 * markdown or HTML — which is why this returns data, not a message.
 */

export type SetOutcome =
  | {
      ok: true;
      key: SettingKey;
      /** What actually went into the settings table. */
      storedValue: string;
      /** Present when a usergroup handle was resolved to a group id. */
      groupHandle?: string;
    }
  | { ok: false; reason: string };

export async function applySettingInput(
  client: WebClient,
  rawKey: string,
  rawValue: string,
  setBy: string
): Promise<SetOutcome> {
  const checked = checkSetting(rawKey, rawValue);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  // All three usergroup settings are set by handle, but membership checks
  // need the Slack-internal group id — resolved here, once, rather than on
  // every check. See CONTEXT.md, HawkBot Admin. Deliberately a fresh list,
  // not nameResolution.ts's 5-minute cache: a group created moments ago must
  // be settable immediately.
  if (
    checked.key === "admin_usergroup" ||
    checked.key === "student_usergroup" ||
    checked.key === "mentor_usergroup"
  ) {
    const groups = await client.usergroups.list({});
    const match = groups.usergroups?.find(
      (g) => g.handle?.toLowerCase() === checked.value.toLowerCase()
    );
    if (!match?.id) {
      return {
        ok: false,
        reason: `No Slack User Group found with handle \`${checked.value}\`. Check the handle and try again.`,
      };
    }
    setSetting(checked.key, match.id, setBy);
    return {
      ok: true,
      key: checked.key,
      storedValue: match.id,
      groupHandle: checked.value,
    };
  }

  setSetting(checked.key, checked.value, setBy);
  return { ok: true, key: checked.key, storedValue: checked.value };
}

export type UnsetOutcome =
  | { ok: true; key: SettingKey; removed: boolean }
  | { ok: false; reason: string };

export function applySettingUnset(rawKey: string): UnsetOutcome {
  const setting = findSetting(rawKey);
  if (!setting) {
    const known = SETTINGS.map((s) => s.key).join(", ");
    return {
      ok: false,
      reason: `Unknown setting \`${rawKey}\`. Known: ${known}`,
    };
  }
  return { ok: true, key: setting.key, removed: clearSetting(setting.key) };
}

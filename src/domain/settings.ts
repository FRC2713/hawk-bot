/**
 * Workspace configuration the coaches set from Slack, as opposed to the
 * credentials and hostnames the operator sets in `.env`.
 *
 * Every key is declared here. `/hawk config set` refuses anything not in this
 * list, because the failure it prevents is silent: a mistyped key would store
 * cleanly, read back as unset wherever the feature looks for it, and present
 * as "the bot ignored me".
 *
 * Pure data and pure functions — no database, no Slack client — so the rules
 * are testable without either.
 */
export type SettingKey = "announce_channel" | "timezone_note";

export type Setting = {
  key: SettingKey;
  summary: string;
  /** Shown when the value is rejected, so the message can say what is wanted. */
  expects: string;
  validate: (value: string) => boolean;
};

/** A Slack channel id, as it arrives from `#channel` autocomplete or by hand. */
const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

export const SETTINGS: readonly Setting[] = [
  {
    key: "announce_channel",
    summary: "Channel Hawk Bot posts team-wide announcements to",
    expects: "a channel id like C0123456789 (not the #name)",
    validate: (v) => CHANNEL_ID.test(v.trim()),
  },
  {
    key: "timezone_note",
    summary: "Free text shown on the App Home, e.g. meeting nights",
    expects: "any text up to 200 characters",
    validate: (v) => v.trim().length > 0 && v.trim().length <= 200,
  },
];

export function findSetting(key: string): Setting | undefined {
  return SETTINGS.find((s) => s.key === key.trim().toLowerCase());
}

export type SettingCheck =
  { ok: true; key: SettingKey; value: string } | { ok: false; reason: string };

/**
 * The whole of `config set`'s validation, so the Slack handler is left with
 * nothing but I/O.
 */
export function checkSetting(key: string, value: string): SettingCheck {
  const setting = findSetting(key);
  if (!setting) {
    const known = SETTINGS.map((s) => s.key).join(", ");
    return { ok: false, reason: `Unknown setting \`${key}\`. Known: ${known}` };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, reason: `\`${setting.key}\` needs ${setting.expects}` };
  }
  // Slack turns a typed `#general` into `<#C0123|general>` when the command is
  // escaped. Unwrap it rather than telling a coach their own channel is wrong.
  const unwrapped = unwrapChannel(trimmed);
  if (!setting.validate(unwrapped)) {
    return {
      ok: false,
      reason: `\`${unwrapped}\` is not valid for \`${setting.key}\` — expected ${setting.expects}`,
    };
  }
  return { ok: true, key: setting.key, value: unwrapped };
}

/** `<#C0123456789|general>` → `C0123456789`; anything else is returned as is. */
export function unwrapChannel(value: string): string {
  const match = /^<#([CG][A-Z0-9]+)(\|[^>]*)?>$/.exec(value.trim());
  return match?.[1] ?? value.trim();
}

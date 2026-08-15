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
export type SettingKey =
  | "announce_channel"
  | "timezone_note"
  | "google_calendar_id"
  | "checkin_offset_hourly_hours"
  | "checkin_offset_allday_time"
  | "default_all_day_hours"
  | "attendance_report_channel"
  | "admin_usergroup"
  | "weekly_summary_time";

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
  {
    key: "google_calendar_id",
    summary: "The Team Meeting Calendar's id — the source of truth for Events",
    expects: "a Google Calendar id, e.g. team@group.calendar.google.com",
    validate: (v) => v.trim().length > 0 && v.trim().length <= 200,
  },
  {
    key: "checkin_offset_hourly_hours",
    summary:
      "How many hours before an Hourly meeting its Check-in Post goes out",
    expects: "a whole number of hours, e.g. 4",
    validate: (v) => /^\d+$/.test(v.trim()) && Number(v.trim()) > 0,
  },
  {
    key: "checkin_offset_allday_time",
    summary:
      "What time, the day before, an All-Day meeting's Check-in Post goes out",
    expects: "a 24-hour time HH:MM, e.g. 16:00",
    validate: (v) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(v.trim()),
  },
  {
    key: "default_all_day_hours",
    summary:
      "Hours credited for an All-Day meeting, since it has no scheduled start/end time",
    expects: "a positive number of hours, e.g. 8",
    validate: (v) => {
      const n = Number(v.trim());
      return v.trim().length > 0 && Number.isFinite(n) && n > 0;
    },
  },
  {
    key: "attendance_report_channel",
    summary:
      "Private channel the Event Attendance Report posts to after each Event's cutoff",
    expects: "a channel id like C0123456789 (not the #name)",
    validate: (v) => CHANNEL_ID.test(v.trim()),
  },
  {
    key: "admin_usergroup",
    summary:
      "The Slack User Group whose members are HawkBot Admins (workspace Owners always are too)",
    expects: "a user group handle, e.g. hawkbot-admins (with or without the @)",
    // Format only — this doesn't confirm the group actually exists. That
    // live lookup (handle -> Slack's internal group id) happens as an I/O
    // step in commands/config.ts, which is what actually gets stored.
    validate: (v) => /^[a-zA-Z0-9_-]{1,80}$/.test(v.trim()),
  },
  {
    key: "weekly_summary_time",
    summary: "When the Weekly Summary Post goes out",
    expects: "a day and 24-hour time, e.g. SUN 12:00",
    validate: (v) =>
      /^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([01]\d|2[0-3]):([0-5]\d)$/i.test(
        v.trim()
      ),
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
  // Slack turns a typed `#general` into `<#C0123|general>`, and a typed
  // `@handle` into `<!subteam^S0123|@handle>`, when the command is escaped.
  // Unwrap either rather than telling a coach their own channel/group is
  // wrong. Both are no-ops for a value that doesn't match their pattern.
  const unwrapped = unwrapUserGroupHandle(unwrapChannel(trimmed));
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

/**
 * `<!subteam^S0123|@hawkbot-admins>` → `hawkbot-admins`; a plain `@handle`
 * has its `@` stripped; anything else is returned as is. This is the
 * *handle*, not the group's Slack-internal id — resolving handle to id is
 * a live lookup, done as an I/O step in commands/config.ts.
 */
export function unwrapUserGroupHandle(value: string): string {
  const trimmed = value.trim();
  const escaped = /^<!subteam\^[A-Z0-9]+\|@?([^>]+)>$/.exec(trimmed);
  if (escaped?.[1]) return escaped[1];
  return trimmed.replace(/^@/, "");
}

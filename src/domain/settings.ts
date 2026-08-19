/**
 * Workspace configuration the coaches set from Slack, as opposed to the
 * credentials and hostnames the operator sets in `.env`.
 *
 * Every key is declared here. `/hawkbot config set` refuses anything not in this
 * list, because the failure it prevents is silent: a mistyped key would store
 * cleanly, read back as unset wherever the feature looks for it, and present
 * as "the bot ignored me".
 *
 * Pure data and pure functions — no database, no Slack client — so the rules
 * are testable without either.
 */
export type SettingKey =
  | "announce_channel"
  | "home_note"
  | "team_meeting_calendar_id"
  | "google_impersonated_user"
  | "checkin_offset_hourly_hours"
  | "checkin_offset_allday_time"
  | "checkin_offset_multiday_days"
  | "default_all_day_hours"
  | "attendance_report_channel"
  | "admin_usergroup"
  | "weekly_summary_time"
  | "informational_calendar_id"
  | "mentor_calendar_id"
  | "mentor_summary_channel"
  | "mentor_summary_time"
  | "no_response_alert_channel"
  | "no_response_alert_time"
  | "no_response_alert_threshold"
  | "student_usergroup"
  | "mentor_usergroup";

export type Setting = {
  key: SettingKey;
  summary: string;
  /** Shown when the value is rejected, so the message can say what is wanted. */
  expects: string;
  validate: (value: string) => boolean;
  /**
   * Declares this setting's stored value as a Slack channel id or Slack User
   * Group id, so `/hawkbot config` can resolve it to a human-readable name
   * for display. Unset for every setting that isn't one of those two shapes —
   * explicit here rather than re-derived from `validate`, which a display
   * concern shouldn't need to reverse-engineer.
   */
  resolveAs?: "channel" | "usergroup";
};

/** A Slack channel id, as it arrives from `#channel` autocomplete or by hand. */
const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

/**
 * A Google Calendar id: `primary`, or the address-shaped id Google shows under
 * *Integrate calendar* — `team@group.calendar.google.com`, and the odd
 * `en.usa#holiday@group.v.calendar.google.com` for a subscribed public one.
 *
 * ASCII-only on purpose, and that is the whole reason this check exists rather
 * than a length check. A calendar id is copied out of a browser and pasted
 * into Slack, and a paste can carry a zero-width space (U+200B) or a
 * non-breaking space. Neither is removed by `trim()`, both render as nothing
 * at all, and both survive into the request URL as `%E2%80%8B` / `%C2%A0` — so
 * Google returns 404 for a calendar that is shared perfectly correctly, and
 * the stored value still looks right in every message that echoes it back.
 * That failure is unfalsifiable from Slack; this makes it unstorable instead.
 */
const CALENDAR_ID = /^(primary|[A-Za-z0-9._%+#-]+@[A-Za-z0-9.-]+)$/;

/**
 * Whether a string is shaped like a calendar id at all. Exported so an ad-hoc
 * probe (`/hawkbot calendar <id>`) applies exactly the rule `config set`
 * applies — a probe that accepted an id the setting would reject would be
 * testing something the bot can never actually be configured with.
 */
export function isCalendarId(value: string): boolean {
  return CALENDAR_ID.test(value.trim());
}

const CALENDAR_ID_EXPECTS =
  "a Google Calendar id like team@group.calendar.google.com — copy it from " +
  "the calendar's Settings and sharing → Integrate calendar. If it looks " +
  "right and is still rejected, the paste carried an invisible character; " +
  "retype the id by hand.";

/**
 * An address inside the Google Workspace, for delegation. Shape only — whether
 * the account exists and whether the delegation grant was actually made are
 * both live questions Google answers, and `/hawkbot calendar` asks it.
 */
const WORKSPACE_USER = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export const SETTINGS: readonly Setting[] = [
  {
    key: "announce_channel",
    summary: "Channel Hawk Bot posts team-wide announcements to",
    expects: "a channel id like C0123456789 (not the #name)",
    validate: (v) => CHANNEL_ID.test(v.trim()),
    resolveAs: "channel",
  },
  {
    key: "home_note",
    summary: "Free text shown on the App Home, e.g. meeting nights",
    expects: "any text up to 200 characters",
    validate: (v) => v.trim().length > 0 && v.trim().length <= 200,
  },
  {
    key: "team_meeting_calendar_id",
    summary: "The Team Meeting Calendar's id — the source of truth for Events",
    expects: CALENDAR_ID_EXPECTS,
    validate: (v) => CALENDAR_ID.test(v.trim()),
  },
  {
    key: "google_impersonated_user",
    summary:
      "A Google Workspace account to read calendars *as* (domain-wide delegation) — set this when a Workspace refuses to share its calendars with the service account. Unset to read as the service account itself",
    expects:
      "a Workspace email like calendar@yourteam.org, or unset to disable delegation",
    validate: (v) => WORKSPACE_USER.test(v.trim()),
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
    key: "checkin_offset_multiday_days",
    summary:
      "How many days before a Multi-Day Event's first day every one of its per-day Check-in Posts goes out together",
    expects: "a whole number of days, e.g. 2",
    validate: (v) => /^\d+$/.test(v.trim()) && Number(v.trim()) > 0,
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
    resolveAs: "channel",
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
    resolveAs: "usergroup",
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
  {
    key: "informational_calendar_id",
    summary:
      "The Informational Calendar's id — set to enable it, unset to disable. Its Events post as a threaded reply under the Weekly Summary Post",
    expects: CALENDAR_ID_EXPECTS,
    validate: (v) => CALENDAR_ID.test(v.trim()),
  },
  {
    key: "mentor_calendar_id",
    summary:
      "The Mentor/Teacher Calendar's id — set to enable it, unset to disable. Its Events post to the Mentor/Teacher Weekly Summary",
    expects: CALENDAR_ID_EXPECTS,
    validate: (v) => CALENDAR_ID.test(v.trim()),
  },
  {
    key: "mentor_summary_channel",
    summary: "Channel the Mentor/Teacher Weekly Summary posts to",
    expects: "a channel id like C0123456789 (not the #name)",
    validate: (v) => CHANNEL_ID.test(v.trim()),
    resolveAs: "channel",
  },
  {
    key: "mentor_summary_time",
    summary: "When the Mentor/Teacher Weekly Summary goes out",
    expects: "a day and 24-hour time, e.g. SUN 12:00",
    validate: (v) =>
      /^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([01]\d|2[0-3]):([0-5]\d)$/i.test(
        v.trim()
      ),
  },
  {
    key: "no_response_alert_channel",
    summary:
      "Private channel the No Response Alert Report posts to — set to enable it, unset to disable",
    expects: "a channel id like C0123456789 (not the #name)",
    validate: (v) => CHANNEL_ID.test(v.trim()),
    resolveAs: "channel",
  },
  {
    key: "no_response_alert_time",
    summary: "When the No Response Alert Report goes out",
    expects: "a day and 24-hour time, e.g. MON 09:00",
    validate: (v) =>
      /^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+([01]\d|2[0-3]):([0-5]\d)$/i.test(
        v.trim()
      ),
  },
  {
    key: "no_response_alert_threshold",
    summary:
      "How many consecutive No Responses on Team Meetings triggers a flag",
    expects: "a whole number of meetings, e.g. 3",
    validate: (v) => /^\d+$/.test(v.trim()) && Number(v.trim()) > 0,
  },
  {
    key: "student_usergroup",
    summary:
      "The Slack User Group holding the team's students — the No Response Alert Report only ever evaluates Students and Mentors",
    expects: "a user group handle, e.g. hawk-students (with or without the @)",
    // Format only, same as admin_usergroup — the live handle -> group id
    // lookup happens as an I/O step in commands/config.ts.
    validate: (v) => /^[a-zA-Z0-9_-]{1,80}$/.test(v.trim()),
    resolveAs: "usergroup",
  },
  {
    key: "mentor_usergroup",
    summary:
      "The Slack User Group holding the team's mentors — the No Response Alert Report only ever evaluates Students and Mentors",
    expects: "a user group handle, e.g. hawk-mentors (with or without the @)",
    validate: (v) => /^[a-zA-Z0-9_-]{1,80}$/.test(v.trim()),
    resolveAs: "usergroup",
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
  // Slack turns a typed `#general` into `<#C0123|general>`, a typed `@handle`
  // into `<!subteam^S0123|@handle>`, and a typed email into
  // `<mailto:a@b.org|a@b.org>` — and passes code-formatted text through with
  // its backticks attached. Unwrap all four rather than telling a coach their
  // own channel, group, address or correctly-escaped value is wrong. Each is a
  // no-op for a value that doesn't match its pattern.
  const unwrapped = unwrapEmail(
    unwrapUserGroupHandle(unwrapChannel(unwrapCode(trimmed)))
  );
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
 * Strips the backticks off a code-formatted value.
 *
 * Wrapping a value in backticks is the standard way to stop Slack linkifying
 * it — and it works, but Slack passes the backticks through to the command as
 * literal characters. So the advice that defeats one mangling introduces
 * another, and the coach who followed instructions correctly gets a rejection
 * quoting a value that looks right apart from punctuation they were told to
 * add. Accepting the form we tell people to use is the least we can do.
 */
export function unwrapCode(value: string): string {
  const trimmed = value.trim();
  return /^`{1,3}([^`]+)`{1,3}$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
}

/**
 * `<mailto:calendar@team.org|calendar@team.org>` → `calendar@team.org`;
 * anything else is returned as is.
 *
 * Slack linkifies anything that looks like an address, so a setting that takes
 * an email never receives what was typed. The rejection this prevents is a
 * genuinely maddening one: Slack *renders* the escaped form back as the bare
 * address, so the error message quotes a value identical to the one the coach
 * typed and appears to reject it for no reason at all.
 */
export function unwrapEmail(value: string): string {
  const match = /^<mailto:([^|>]+)(\|[^>]*)?>$/.exec(value.trim());
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

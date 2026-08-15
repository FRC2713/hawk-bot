import { JWT } from "google-auth-library";
import { config } from "../config.js";
import type { RawCalendarEvent } from "../domain/calendar.js";

const CALENDAR_READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";

// Bounds how far the sync looks: a day back (to catch same-day edits to an
// event that already started) through 60 days out. Not something the
// grilling session pinned down — a reasonable starting window, easy to widen
// later if the team schedules further ahead than that.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 60 * 24 * 60 * 60 * 1000;

let cachedClient: JWT | null = null;

function serviceAccountClient(): JWT {
  if (cachedClient) return cachedClient;
  const json = JSON.parse(
    Buffer.from(config().GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, "base64").toString(
      "utf8"
    )
  ) as { client_email: string; private_key: string };
  cachedClient = new JWT({
    email: json.client_email,
    key: json.private_key,
    scopes: [CALENDAR_READONLY_SCOPE],
  });
  return cachedClient;
}

type CalendarEventsResponse = {
  items?: RawCalendarEvent[];
};

/**
 * Every event on the given calendar due for a sync pass — the Team Meeting,
 * Informational, or Mentor/Teacher Calendar alike, all read through the same
 * shared service account. Expanded (`singleEvents=true`) so a recurring
 * weekly practice comes back as its individual occurrences with real
 * start/end times, not one master event with a recurrence rule.
 * `showDeleted=true` is how a cancellation is detected — Google reports it
 * as `status: "cancelled"` rather than simply omitting it, see
 * domain/calendar.ts's Calendar Change Handling.
 */
export async function fetchCalendarEvents(
  calendarId: string,
  now: Date = new Date()
): Promise<RawCalendarEvent[]> {
  const client = serviceAccountClient();
  const params = new URLSearchParams({
    singleEvents: "true",
    showDeleted: "true",
    orderBy: "startTime",
    timeMin: new Date(now.getTime() - LOOKBACK_MS).toISOString(),
    timeMax: new Date(now.getTime() + LOOKAHEAD_MS).toISOString(),
    fields:
      "items(id,status,summary,description,location,start,end,updated,htmlLink)",
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;

  const res = await client.request<CalendarEventsResponse>({ url });
  return res.data.items ?? [];
}

import { JWT } from "google-auth-library";
import { config } from "../config.js";
import type { RawCalendarEvent } from "../domain/calendar.js";
import {
  describeCalendarAccessFailure,
  parseServiceAccountKey,
  readGoogleError,
} from "../domain/calendarAccess.js";

const CALENDAR_READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";

// Bounds how far the sync looks: a day back (to catch same-day edits to an
// event that already started) through 60 days out. Not something the
// grilling session pinned down — a reasonable starting window, easy to widen
// later if the team schedules further ahead than that.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * The API's own ceiling for `events.list`. Asking for it explicitly matters:
 * the default is 250, and Google truncates silently — no error, no warning,
 * just a `nextPageToken` that a caller who never looks at it will never see.
 * With `orderBy=startTime` the events dropped are the *furthest out*, so the
 * symptom is a calendar that syncs correctly for a few weeks and then stops,
 * which reads as a broken sync rather than as a paging bug.
 */
const MAX_RESULTS = 2500;

/**
 * A backstop, not a limit anyone should reach: 20 pages is 50,000 events in a
 * 61-day window. Its job is to turn a server that echoes the same page token
 * forever into an error instead of a hung scheduler tick holding the lock on
 * every step behind it.
 */
const MAX_PAGES = 20;

let cachedClient: JWT | null = null;
let cachedEmail: string | null = null;

function serviceAccountClient(): JWT {
  if (cachedClient) return cachedClient;
  const { clientEmail, privateKey } = parseServiceAccountKey(
    config().GOOGLE_SERVICE_ACCOUNT_KEY_BASE64
  );
  cachedEmail = clientEmail;
  cachedClient = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [CALENDAR_READONLY_SCOPE],
  });
  return cachedClient;
}

/**
 * The address a calendar has to be shared with, which is the one fact an
 * operator needs and cannot get anywhere else — it lives inside a base64
 * credential nobody can read from Slack. Surfaced by `/hawkbot calendar`.
 *
 * Throws the same actionable error as a sync would if the credential is
 * unreadable, rather than returning undefined and letting the caller report
 * a working setup.
 */
export function serviceAccountEmail(): string {
  if (cachedEmail) return cachedEmail;
  return parseServiceAccountKey(config().GOOGLE_SERVICE_ACCOUNT_KEY_BASE64)
    .clientEmail;
}

export type CalendarEventsPage = {
  items?: RawCalendarEvent[];
  nextPageToken?: string;
};

/**
 * Follows `nextPageToken` to the end and concatenates the items.
 *
 * Split out from the request building so the paging rule is testable without
 * a Google client: a fake `fetchPage` is the whole seam.
 */
export async function collectEventPages(
  fetchPage: (pageToken: string | undefined) => Promise<CalendarEventsPage>
): Promise<RawCalendarEvent[]> {
  const events: RawCalendarEvent[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await fetchPage(pageToken);
    events.push(...(response.items ?? []));
    if (!response.nextPageToken) return events;
    pageToken = response.nextPageToken;
  }

  throw new Error(
    `Google Calendar returned more than ${MAX_PAGES} pages of events for a ` +
      "60-day window, which should not be possible. Refusing to keep paging."
  );
}

/**
 * Every event on the given calendar due for a sync pass — the Team Meeting,
 * Informational, or Mentor/Teacher Calendar alike, all read through the same
 * shared service account. Expanded (`singleEvents=true`) so a recurring
 * weekly practice comes back as its individual occurrences with real
 * start/end times, not one master event with a recurrence rule.
 * `showDeleted=true` is how a cancellation is detected — Google reports it
 * as `status: "cancelled"` rather than simply omitting it, see
 * domain/calendar.ts's Calendar Change Handling. That also means cancelled
 * instances count against the page size, so a busy calendar reaches a second
 * page sooner than its visible event count suggests.
 *
 * A refusal from Google is rethrown with the fix attached — see
 * domain/calendarAccess.ts for why the raw message is not enough.
 */
export async function fetchCalendarEvents(
  calendarId: string,
  now: Date = new Date()
): Promise<RawCalendarEvent[]> {
  const client = serviceAccountClient();

  return collectEventPages(async (pageToken) => {
    const params = new URLSearchParams({
      singleEvents: "true",
      showDeleted: "true",
      orderBy: "startTime",
      maxResults: String(MAX_RESULTS),
      timeMin: new Date(now.getTime() - LOOKBACK_MS).toISOString(),
      timeMax: new Date(now.getTime() + LOOKAHEAD_MS).toISOString(),
      // nextPageToken has to be in the mask: a partial response drops every
      // field not named here, so asking only for `items` is exactly how a
      // truncated result becomes invisible.
      fields:
        "nextPageToken,items(id,status,summary,description,location,start,end,updated,htmlLink)",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;

    // Only the request is wrapped. A failure raised by this module itself
    // (the page-count backstop, a bad credential) already says what to do,
    // and re-labelling it "Google said:" would blame the wrong party.
    try {
      const res = await client.request<CalendarEventsPage>({ url });
      return res.data;
    } catch (err) {
      const { status, message } = readGoogleError(err);
      throw new Error(
        describeCalendarAccessFailure(status, message, {
          calendarId,
          serviceAccountEmail: cachedEmail ?? undefined,
        })
      );
    }
  });
}

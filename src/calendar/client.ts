import { JWT } from "google-auth-library";
import { config } from "../config.js";
import type { RawCalendarEvent } from "../domain/calendar.js";
import {
  describeCalendarAccessFailure,
  parseServiceAccountKey,
  readGoogleError,
  type AccessibleCalendar,
  type ServiceAccountKey,
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

/**
 * How to reach Google for one call.
 *
 * `subject` turns on domain-wide delegation: the service account stops acting
 * as itself and acts *as* that Workspace user. This is not a nicety. A Google
 * Workspace can accept an external principal in a calendar's sharing dialog,
 * display the entry indefinitely, and still refuse it through the API — the
 * share looks correct and returns 404, because a service account in its own
 * Cloud project is outside the domain. Impersonating a user inside the domain
 * sidesteps the external-sharing policy entirely: the calendars do not have to
 * be shared with anything, because the bot is already that user.
 *
 * The alternative is loosening external sharing for the whole organization,
 * which is a change to every calendar in it to fix one integration.
 */
export type CalendarAccess = {
  /** A Workspace user to act as, e.g. `calendar@yourteam.org`. */
  subject?: string | undefined;
  /** Overridable only so the sync window is testable. */
  now?: Date;
};

// Keyed by subject: switching impersonation must not silently reuse a client
// still authenticating as the previous identity, which would present as a
// setting that appears to save and change nothing.
const clientCache = new Map<string, JWT>();
let cachedKey: ServiceAccountKey | null = null;

function serviceAccountKey(): ServiceAccountKey {
  cachedKey ??= parseServiceAccountKey(
    config().GOOGLE_SERVICE_ACCOUNT_KEY_BASE64
  );
  return cachedKey;
}

function serviceAccountClient(subject?: string): JWT {
  const cacheKey = subject ?? "";
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;

  const { clientEmail, privateKey } = serviceAccountKey();
  const client = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [CALENDAR_READONLY_SCOPE],
    ...(subject ? { subject } : {}),
  });
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Who Hawk Bot is to Google, for `/hawkbot calendar` to report.
 *
 * `clientId` is included because it is what a Workspace admin pastes into the
 * Domain-wide delegation screen, and it exists nowhere an operator can reach —
 * inside a base64 secret, in a 600-mode .env, on a host nobody SSHes into.
 *
 * Throws the same actionable error a sync would if the credential is
 * unreadable, rather than returning undefined and letting a caller report a
 * working setup.
 */
export function serviceAccountIdentity(): {
  email: string;
  clientId: string | undefined;
} {
  const key = serviceAccountKey();
  return { email: key.clientEmail, clientId: key.clientId };
}

/** Just the address, for the many callers that only need that. */
export function serviceAccountEmail(): string {
  return serviceAccountKey().clientEmail;
}

export type CalendarEventsPage = {
  items?: RawCalendarEvent[];
  nextPageToken?: string;
};

/**
 * Everything Google says this service account can reach, from its own calendar
 * list rather than from anything configured here.
 *
 * This is the question a per-calendar 404 cannot answer. `events.list` on one
 * id returns the same "Not Found" whether the id is wrong, the share never
 * took effect, or a Workspace policy hides it — so the useful move is to stop
 * asking about a specific id and ask what the account can see at all. An empty
 * list and a list that simply omits the configured id point at completely
 * different fixes.
 *
 * Under impersonation this is the *impersonated user's* list, which is the
 * more useful answer of the two: it shows the calendars the bot will actually
 * be able to read, without anything having been shared with a service account
 * at all.
 */
export async function fetchAccessibleCalendars(
  access: CalendarAccess = {}
): Promise<AccessibleCalendar[]> {
  const client = serviceAccountClient(access.subject);
  const calendars: AccessibleCalendar[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      maxResults: "250",
      // minAccessRole is deliberately unset: a calendar shared at
      // "See only free/busy" must still appear, because that *is* one of the
      // findings — it looks like access and produces detail-free events.
      fields: "nextPageToken,items(id,summary,accessRole,primary)",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`;
    const res = await client.request<{
      items?: AccessibleCalendar[];
      nextPageToken?: string;
    }>({ url });

    calendars.push(...(res.data.items ?? []));
    if (!res.data.nextPageToken) return calendars;
    pageToken = res.data.nextPageToken;
  }

  return calendars;
}

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
  access: CalendarAccess = {}
): Promise<RawCalendarEvent[]> {
  const client = serviceAccountClient(access.subject);
  const now = access.now ?? new Date();

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
      throw new Error(
        describeCalendarAccessFailure(readGoogleError(err), {
          calendarId,
          serviceAccountEmail: cachedKey?.clientEmail,
          impersonating: access.subject,
        })
      );
    }
  });
}

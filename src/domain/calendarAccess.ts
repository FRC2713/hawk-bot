/**
 * Getting *at* Google Calendar, as opposed to interpreting what comes back
 * (that's domain/calendar.ts): reading the service account credential, and
 * turning a refusal from Google into something a mentor can act on.
 *
 * Pure data and pure functions — no Google client, no network — so the rules
 * are testable without either.
 *
 * This module exists because every failure here presents identically to the
 * person reporting it ("the bot can't see the calendar"), while the fixes are
 * completely different and live in three different places: the GitHub secret,
 * the Google Cloud console, and the calendar's own sharing dialog. A message
 * that says "Not Found" — which is verbatim what Google returns when a
 * calendar was never shared — sends people to check the calendar id, which is
 * almost never what's wrong.
 */

export type ServiceAccountKey = {
  clientEmail: string;
  privateKey: string;
  /**
   * The account's numeric OAuth client id. Not needed to authenticate at all —
   * it is here because it is the value a Workspace admin has to paste into
   * Admin console → Security → API controls → Domain-wide delegation, and it
   * is otherwise buried in a base64 secret nobody can read. Optional: older
   * key files predate the field, and its absence must not stop a sync.
   */
  clientId?: string;
};

/** How the credential is produced, quoted in errors so the fix is at hand. */
const HOW_TO_ENCODE = "base64 -i service-account.json | tr -d '\\n'";

/**
 * Decodes `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` into the two fields the JWT
 * client needs.
 *
 * Every throw here names what the value actually looked like. `Buffer.from`
 * with "base64" never fails — it silently discards anything outside the
 * alphabet and truncates a partial final group — so a value that was pasted
 * un-encoded, truncated by terminal wrapping, or encoded from the wrong file
 * arrives as plausible-looking garbage rather than as an error. Without this,
 * all three surface as `Unexpected token 'r', "rX..." is not valid JSON`.
 *
 * Line breaks inside the value are fine: base64 decoding ignores them, so a
 * key that got wrapped on its way into a secret store still works. Only a
 * value that lost characters is unrecoverable.
 */
export function parseServiceAccountKey(base64: string): ServiceAccountKey {
  const trimmed = base64.trim();
  if (!trimmed) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 is empty. It holds the service " +
        `account's JSON key, base64-encoded onto one line: ${HOW_TO_ENCODE}`
    );
  }

  // The single most common mis-paste: the JSON itself, not its base64.
  if (trimmed.startsWith("{")) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 holds raw JSON, not base64. The " +
        "private key inside it contains newlines, which is why it has to be " +
        `encoded before it can live on one line of .env: ${HOW_TO_ENCODE}`
    );
  }

  const decoded = Buffer.from(trimmed, "base64").toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 did not decode to JSON. It is " +
        "usually a value that lost characters to line wrapping when it was " +
        "copied, or one encoded from the wrong file. Re-encode the service " +
        `account's JSON key in one step: ${HOW_TO_ENCODE}`
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 decoded to JSON, but not to an " +
        "object. Expected a service account key file."
    );
  }

  const key = parsed as Record<string, unknown>;

  // An OAuth *client* secret is the other JSON file the Google Cloud console
  // offers to download, from a page one click away, and it is useless here —
  // it identifies an app asking a human for consent, not an account that can
  // act on its own.
  if ("installed" in key || "web" in key) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 holds an OAuth client secret, not a " +
        "service account key. Both download as JSON from the Google Cloud " +
        "console. The one wanted here comes from IAM & Admin → Service " +
        'Accounts → Keys, and its JSON has a top-level "type": ' +
        '"service_account".'
    );
  }

  if (key.type !== undefined && key.type !== "service_account") {
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 has "type": ${JSON.stringify(key.type)}, ` +
        'expected "service_account".'
    );
  }

  const clientEmail = key.client_email;
  const privateKey = key.private_key;

  if (typeof clientEmail !== "string" || !clientEmail) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 decoded to JSON with no " +
        "`client_email`. That field is the address the calendar has to be " +
        "shared with, so a key without it cannot work."
    );
  }
  if (typeof privateKey !== "string" || !privateKey) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 decoded to JSON with no " +
        "`private_key`. Download the key file again — the console only offers " +
        "the private key at creation time, and a key file that has been " +
        "opened and re-saved sometimes loses it."
    );
  }

  const clientId = key.client_id;
  return {
    clientEmail,
    privateKey,
    ...(typeof clientId === "string" && clientId ? { clientId } : {}),
  };
}

/** What `describeCalendarAccessFailure` needs to name names. */
export type CalendarAccessContext = {
  calendarId: string;
  /** Undefined when the credential itself is what failed to load. */
  serviceAccountEmail?: string;
  /** The Workspace user being impersonated, when delegation is configured. */
  impersonating?: string | undefined;
};

/** What `readGoogleError` extracted, as `describeCalendarAccessFailure` wants it. */
export type GoogleFailure = {
  status: number | undefined;
  message: string;
  reason?: string | undefined;
};

/**
 * Google's own error text, with the fix appended.
 *
 * The refusals below are the ones a first-time setup actually hits, and
 * Google's wording for the most common of them — a bare "Not Found" for a
 * calendar that exists but was never shared — actively misleads. Anything
 * unrecognized is passed through verbatim rather than guessed at; a wrong
 * explanation is worse than none.
 *
 * Every branch ends with Google's raw status and `reason`. That is not noise:
 * a 404 alone cannot distinguish "never shared" from "an admin policy hides
 * this from your app", and chasing the wrong one of those costs an afternoon.
 * `reason` is the field that separates them, and it is the field a support
 * thread will ask for.
 */
export function describeCalendarAccessFailure(
  failure: GoogleFailure,
  ctx: CalendarAccessContext
): string {
  const { status, message, reason } = failure;
  const sharedWith = ctx.serviceAccountEmail
    ? `\`${ctx.serviceAccountEmail}\``
    : "the service account's own email address";
  const raw = `_Google: ${status ?? "no status"}${reason ? ` ${reason}` : ""} — ${message}_`;

  // A Workspace admin can block an OAuth client from reaching the domain's
  // data outright (Admin console → Security → API controls). Calendar reports
  // that as the resource simply not existing, so it is indistinguishable from
  // an unshared calendar unless `reason` says otherwise.
  if (reason === "domainPolicy" || /domain polic/i.test(message)) {
    return [
      `A Google Workspace policy is blocking this app from \`${ctx.calendarId}\`.`,
      "This is not a sharing problem and cannot be fixed from the calendar's sharing dialog.",
      "A Workspace admin has to allow the service account's OAuth client under Admin console → Security → Access and data control → API controls → App access control.",
      raw,
    ].join("\n");
  }

  if (status === 404 && ctx.impersonating) {
    return [
      `Google can't see the calendar \`${ctx.calendarId}\` as \`${ctx.impersonating}\`.`,
      `Delegation is on, so sharing with the service account is no longer the question — the question is whether *${ctx.impersonating}* can see this calendar. Open Google Calendar signed in as that user and check it is in their list.`,
      "If it is, the delegation grant itself may be missing the Calendar scope: Admin console → Security → Access and data control → API controls → Domain-wide delegation, and confirm `https://www.googleapis.com/auth/calendar.readonly` is listed against this client id.",
      raw,
    ].join("\n");
  }

  if (status === 404) {
    return [
      `Google can't see the calendar \`${ctx.calendarId}\`.`,
      `Google returns this for a calendar id that doesn't exist, for one that was never shared with ${sharedWith}, *and* for one a Workspace policy hides from this app — it can't tell you which.`,
      `First: open that calendar's Settings and sharing → "Share with specific people or groups", add ${sharedWith}, and give it at least "See all event details". A service account is not a member of the workspace; nothing is shared with it implicitly.`,
      "If it is already shared — or the calendar is public, which needs no sharing at all — then sharing is not the problem, and a Google Workspace is the usual reason: it will accept an external principal in the sharing dialog, keep displaying the entry, and still refuse it through the API. The dialog even warns that your organization *might* limit external sharing; it does not tell you when it has.",
      "The fix for that is delegation rather than sharing — set `google_impersonated_user` to a Workspace account that already sees these calendars, and the bot reads them as that user instead of as an outsider.",
      raw,
    ].join("\n");
  }

  if (
    status === 403 &&
    /has not been used in project|is disabled/i.test(message)
  ) {
    return [
      "The Google Calendar API is not enabled in the service account's Cloud project.",
      "The credential is fine; the project simply isn't allowed to call this API yet.",
      `Google's own message, which contains the link that enables it: ${message}`,
    ].join("\n");
  }

  if (status === 403) {
    return [
      `The service account can reach \`${ctx.calendarId}\` but is not allowed to read it.`,
      `Re-check the sharing level for ${sharedWith}: "See only free/busy" hides event titles and times, which is not enough. It needs "See all event details".`,
      raw,
    ].join("\n");
  }

  if (
    status === 401 ||
    /invalid_grant|invalid jwt|invalid signature/i.test(message)
  ) {
    return [
      "Google rejected the service account credential itself.",
      "Usually the key was deleted or the service account disabled in the Cloud console, or this host's clock has drifted — a signed assertion more than a few minutes off is refused.",
      raw,
    ].join("\n");
  }

  return raw;
}

/** One entry of what Google says this service account can actually reach. */
export type AccessibleCalendar = {
  id: string;
  summary?: string;
  /** owner | writer | reader | freeBusyReader — the sharing level, as Google sees it. */
  accessRole?: string;
};

export type ConfiguredCalendar = { label: string; calendarId: string };

/**
 * "See only free/busy" — the sharing level that returns events with every
 * detail stripped, so a sync appears to work and produces untitled Events at
 * the wrong times. Worth naming separately from no access at all.
 */
const FREE_BUSY_ONLY = "freeBusyReader";

/**
 * A calendar id stripped of everything that does not survive a round trip
 * through a human: characters that render as nothing (whitespace, zero-width
 * space/joiner U+200B–U+200D, the byte-order mark U+FEFF), and Slack's
 * `<mailto:…|…>` wrapper.
 *
 * Both produce a stored value that displays identically to the correct one and
 * matches nothing. The mailto case is the nastier of the two: a calendar id is
 * address-shaped, so Slack linkifies it on the way in, and then *renders the
 * wrapper back as the bare id* everywhere it is echoed — including in this
 * bot's own diagnostics. It looks right in every message that mentions it, and
 * only Google disagrees, with a 404 indistinguishable from an unshared
 * calendar.
 *
 * Used only to *compare* two ids, never to store one: an id needing this
 * treatment should be corrected at the source, not silently repaired somewhere
 * the operator cannot see it happening.
 */
export function normalizeCalendarId(id: string): string {
  const unwrapped = /^<mailto:([^|>]+)(\|[^>]*)?>$/.exec(id.trim())?.[1] ?? id;
  return unwrapped.replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

/**
 * Turns "which calendars does Google say this account can reach" into the
 * answer to the one question a per-id 404 cannot settle: whether the id is
 * wrong or the share is not in effect.
 *
 * Asking "can I read *this* id" returns the same 404 for both, which is where
 * a first-time setup gets stuck — the sharing dialog shows the entry, so the
 * obvious reading is that Google is wrong. Asking Google to *enumerate* what
 * it can see distinguishes them outright: an empty inventory means no share is
 * in effect anywhere, and a non-empty one that omits the configured ids means
 * the ids point at something else.
 */
export function describeCalendarInventory(
  configured: readonly ConfiguredCalendar[],
  accessible: readonly AccessibleCalendar[]
): string {
  const header = "*What Google says this service account can actually see*";

  if (accessible.length === 0) {
    return [
      header,
      "_Nothing._ Not one calendar, which rules out a mistyped id — an id this account could read would appear here whatever it was configured as.",
      "So no share is in effect. Either the sharing dialog was saved against a different address, or a Google Workspace policy is dropping it: a service account lives outside your Workspace domain, and an admin restriction on external sharing accepts the entry in the UI and then does not grant it.",
      "Reload the calendar's *Settings and sharing* page — if the entry is gone, that is what happened, and the fix is a Workspace admin change or domain-wide delegation rather than anything in Slack.",
    ].join("\n");
  }

  const byId = new Map(accessible.map((c) => [c.id, c]));
  const byNormalized = new Map(
    accessible.map((c) => [normalizeCalendarId(c.id), c])
  );
  const lines = [header];

  const missing = configured.filter((c) => !byId.has(c.calendarId));
  const found = configured.filter((c) => byId.has(c.calendarId));

  for (const { label, calendarId } of found) {
    const entry = byId.get(calendarId)!;
    const role = entry.accessRole ?? "unknown";
    lines.push(
      entry.accessRole === FREE_BUSY_ONLY
        ? `• *${label}* — visible, but shared at *See only free/busy*. Event titles, descriptions and locations are hidden, so this needs raising to "See all event details".`
        : `• *${label}* — visible (\`${role}\`).`
    );
  }

  // A configured id that matches a visible calendar once invisible characters
  // are stripped is not a wrong id at all — it is the right id carrying a
  // zero-width or non-breaking space from a paste. Nothing that echoes the
  // value back can show the difference, so it has to be named explicitly.
  const invisible = missing.filter((c) => {
    const match = byNormalized.get(normalizeCalendarId(c.calendarId));
    return match !== undefined && match.id !== c.calendarId;
  });

  for (const { label } of missing) {
    const isInvisible = invisible.some((c) => c.label === label);
    lines.push(
      isInvisible
        ? `• *${label}* — :rotating_light: matches a calendar this account *can* read, once the stored id is cleaned up. The stored value carries either Slack's \`<mailto:…>\` wrapper or an invisible character, both of which render as the correct id everywhere and match nothing.`
        : `• *${label}* — not in this list.`
    );
  }

  if (invisible.length > 0) {
    lines.push(
      "",
      `Fix by re-setting ${invisible.length === 1 ? "that id" : "those ids"}, wrapping the value in backticks so Slack sends it literally instead of turning it into a link:`,
      ...invisible.map(
        (c) =>
          `    /hawkbot config set … \`${normalizeCalendarId(c.calendarId)}\``
      )
    );
  }

  if (missing.length > 0) {
    lines.push(
      "",
      `This account *can* read ${accessible.length} calendar${accessible.length === 1 ? "" : "s"}, so the credential and the sharing mechanism both work. The configured id${missing.length === 1 ? "" : "s"} above simply are not among them — which means the id is pointing somewhere other than the calendar that was shared.`,
      "Here is everything it can read. If one of these is the calendar you meant, copy its id:",
      ...accessible.map(
        (c) => `    \`${c.id}\`${c.summary ? ` — ${c.summary}` : ""}`
      )
    );
  }

  return lines.join("\n");
}

/**
 * Pulls status and message off whatever the Google client threw. Gaxios puts
 * the API's own message on `.message` and the code on `.status`; the token
 * exchange throws a plain Error carrying the same two. Neither shape is
 * guaranteed, so both are read defensively — a diagnostic that itself throws
 * while explaining a failure is worse than useless.
 */
export function readGoogleError(err: unknown): {
  status: number | undefined;
  message: string;
  /**
   * Google's own machine-readable cause — `notFound`, `forbidden`,
   * `accessNotConfigured`, `domainPolicy`, … Worth surfacing on its own:
   * several distinct causes collapse to the same HTTP status and the same
   * human-facing text, and this is the field that still tells them apart.
   */
  reason: string | undefined;
} {
  const e = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown; data?: unknown };
  };
  const candidates = [e?.status, e?.response?.status, e?.code];
  const status = candidates.find((c): c is number => typeof c === "number");
  const message =
    typeof e?.message === "string" && e.message ? e.message : String(err);

  const body = (e?.response as { data?: unknown } | undefined)?.data as
    | { error?: { errors?: { reason?: unknown }[]; status?: unknown } }
    | undefined;
  const first = body?.error?.errors?.[0]?.reason;
  const grpc = body?.error?.status;
  const reason =
    typeof first === "string"
      ? first
      : typeof grpc === "string"
        ? grpc
        : undefined;

  return { status, message, reason };
}

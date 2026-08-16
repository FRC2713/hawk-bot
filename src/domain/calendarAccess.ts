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

  return { clientEmail, privateKey };
}

/** What `describeCalendarAccessFailure` needs to name names. */
export type CalendarAccessContext = {
  calendarId: string;
  /** Undefined when the credential itself is what failed to load. */
  serviceAccountEmail?: string;
};

/**
 * Google's own error text, with the fix appended.
 *
 * The three refusals below are the ones a first-time setup actually hits, and
 * Google's wording for the most common of them — a bare "Not Found" for a
 * calendar that exists but was never shared — actively misleads. Anything
 * unrecognized is passed through verbatim rather than guessed at; a wrong
 * explanation is worse than none.
 */
export function describeCalendarAccessFailure(
  status: number | undefined,
  message: string,
  ctx: CalendarAccessContext
): string {
  const sharedWith = ctx.serviceAccountEmail
    ? `\`${ctx.serviceAccountEmail}\``
    : "the service account's own email address";

  if (status === 404) {
    return [
      `Google can't see the calendar \`${ctx.calendarId}\`.`,
      `Google returns this both for a calendar id that doesn't exist and for one that was never shared with ${sharedWith} — it can't tell you which.`,
      `Open that calendar's Settings and sharing → "Share with specific people or groups", add ${sharedWith}, and give it at least "See all event details".`,
      "A service account is not a member of the workspace; nothing is shared with it implicitly.",
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
      `Google said: ${message}`,
    ].join("\n");
  }

  if (
    status === 401 ||
    /invalid_grant|invalid jwt|invalid signature/i.test(message)
  ) {
    return [
      "Google rejected the service account credential itself.",
      "Usually the key was deleted or the service account disabled in the Cloud console, or this host's clock has drifted — a signed assertion more than a few minutes off is refused.",
      `Google said: ${message}`,
    ].join("\n");
  }

  return `Google said: ${message}`;
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
} {
  const e = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
    response?: { status?: unknown };
  };
  const candidates = [e?.status, e?.response?.status, e?.code];
  const status = candidates.find((c): c is number => typeof c === "number");
  const message =
    typeof e?.message === "string" && e.message ? e.message : String(err);
  return { status, message };
}

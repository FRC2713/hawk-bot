import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeCalendarAccessFailure,
  describeCalendarInventory,
  parseServiceAccountKey,
  readGoogleError,
} from "../src/domain/calendarAccess.js";
import { collectEventPages } from "../src/calendar/client.js";

const validKey = {
  type: "service_account",
  project_id: "hawk-bot",
  private_key_id: "abc",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
  client_email: "hawk-bot@hawk-bot.iam.gserviceaccount.com",
  client_id: "123",
};

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

// --- reading the credential ------------------------------------------------

test("a well-formed service account key yields its email and private key", () => {
  const parsed = parseServiceAccountKey(encode(validKey));
  assert.equal(parsed.clientEmail, "hawk-bot@hawk-bot.iam.gserviceaccount.com");
  assert.match(parsed.privateKey, /BEGIN PRIVATE KEY/);
});

test("base64 that got wrapped onto several lines still decodes", () => {
  const wrapped = encode(validKey).replace(/(.{40})/g, "$1\n");
  assert.equal(
    parseServiceAccountKey(wrapped).clientEmail,
    validKey.client_email
  );
});

test("surrounding whitespace is tolerated", () => {
  assert.equal(
    parseServiceAccountKey(`  ${encode(validKey)}\n`).clientEmail,
    validKey.client_email
  );
});

// Each of these arrives as plausible-looking garbage rather than as an error,
// because Buffer.from(..., "base64") never throws. The point of the tests is
// that the resulting message names the actual mistake.

test("raw JSON pasted instead of base64 is named as such", () => {
  assert.throws(() => parseServiceAccountKey(JSON.stringify(validKey)), {
    message: /raw JSON, not base64/,
  });
});

test("a value truncated in transit is named as a decoding failure", () => {
  const truncated = encode(validKey).slice(0, 40);
  assert.throws(() => parseServiceAccountKey(truncated), {
    message: /did not decode to JSON|lost characters/,
  });
});

test("an empty credential says what the variable is for", () => {
  assert.throws(() => parseServiceAccountKey("   "), {
    message: /is empty/,
  });
});

test("an OAuth client secret is distinguished from a service account key", () => {
  const clientSecret = { installed: { client_id: "x", client_secret: "y" } };
  assert.throws(() => parseServiceAccountKey(encode(clientSecret)), {
    message: /OAuth client secret, not a service account key/,
  });
});

test("a key file with no client_email explains why that is fatal", () => {
  const { client_email: _omitted, ...rest } = validKey;
  assert.throws(() => parseServiceAccountKey(encode(rest)), {
    message: /no `client_email`/,
  });
});

test("a key file with no private_key explains why that is fatal", () => {
  const { private_key: _omitted, ...rest } = validKey;
  assert.throws(() => parseServiceAccountKey(encode(rest)), {
    message: /no `private_key`/,
  });
});

// --- explaining a refusal --------------------------------------------------

const ctx = {
  calendarId: "team@group.calendar.google.com",
  serviceAccountEmail: "hawk-bot@hawk-bot.iam.gserviceaccount.com",
};

test("a 404 is explained as sharing, not as a missing calendar", () => {
  const text = describeCalendarAccessFailure(
    { status: 404, message: "Not Found", reason: "notFound" },
    ctx
  );
  assert.match(text, /never shared/);
  assert.match(text, /See all event details/);
  // The address to share with has to appear — it is the actionable part.
  assert.match(text, /hawk-bot@hawk-bot\.iam\.gserviceaccount\.com/);
  // …but it must not stop there. A calendar that is already shared, or public,
  // is exactly the case that sent us chasing the sharing dialog for nothing.
  assert.match(text, /already shared|public/);
  assert.match(text, /404 notFound/);
});

test("a 404 still gives the sharing instruction when the email is unknown", () => {
  const text = describeCalendarAccessFailure(
    { status: 404, message: "Not Found" },
    { calendarId: ctx.calendarId }
  );
  assert.match(text, /service account's own email address/);
});

test("a domain policy block is not reported as a sharing problem", () => {
  const text = describeCalendarAccessFailure(
    { status: 404, message: "Not Found", reason: "domainPolicy" },
    ctx
  );
  assert.match(text, /Workspace policy/);
  assert.match(text, /API controls/);
  // The whole point: do not send an admin back to the sharing dialog.
  assert.match(text, /not a sharing problem/);
});

test("a disabled Calendar API is distinguished from a sharing problem", () => {
  const google =
    "Google Calendar API has not been used in project 12345 before or it is disabled. " +
    "Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=12345 then retry.";
  const text = describeCalendarAccessFailure(
    { status: 403, message: google, reason: "accessNotConfigured" },
    ctx
  );
  assert.match(text, /not enabled in the service account's Cloud project/);
  assert.doesNotMatch(text, /never shared/);
  // Google's message carries the one-click enable link; it must survive.
  assert.match(text, /console\.developers\.google\.com/);
});

test("a plain 403 points at the sharing level rather than at the API", () => {
  const text = describeCalendarAccessFailure(
    { status: 403, message: "Forbidden", reason: "forbidden" },
    ctx
  );
  assert.match(text, /free\/busy/);
  assert.doesNotMatch(
    text,
    /not enabled in the service account's Cloud project/
  );
});

test("a rejected assertion points at the key and the clock", () => {
  const text = describeCalendarAccessFailure(
    { status: 400, message: "invalid_grant: Invalid JWT Signature." },
    ctx
  );
  assert.match(text, /rejected the service account credential/);
  assert.match(text, /clock/);
});

test("an unrecognized failure still carries Google's status and reason", () => {
  const text = describeCalendarAccessFailure(
    { status: 500, message: "Backend Error", reason: "backendError" },
    ctx
  );
  assert.match(text, /Backend Error/);
  assert.match(text, /500 backendError/);
});

test("status, message and reason are read off either error shape", () => {
  assert.deepEqual(readGoogleError({ status: 404, message: "Not Found" }), {
    status: 404,
    message: "Not Found",
    reason: undefined,
  });
  assert.deepEqual(
    readGoogleError({ response: { status: 403 }, message: "Forbidden" }),
    { status: 403, message: "Forbidden", reason: undefined }
  );
  // A thrown non-Error must not take the diagnostic down with it.
  assert.deepEqual(readGoogleError("boom"), {
    status: undefined,
    message: "boom",
    reason: undefined,
  });
});

test("Google's machine-readable reason is pulled out of the response body", () => {
  const gaxiosish = {
    status: 404,
    message: "Not Found",
    response: {
      status: 404,
      data: {
        error: {
          errors: [
            { domain: "global", reason: "notFound", message: "Not Found" },
          ],
          code: 404,
          message: "Not Found",
        },
      },
    },
  };
  assert.equal(readGoogleError(gaxiosish).reason, "notFound");
});

test("a gRPC-style status field is used when there is no errors array", () => {
  const err = {
    status: 403,
    message: "denied",
    response: { data: { error: { status: "PERMISSION_DENIED" } } },
  };
  assert.equal(readGoogleError(err).reason, "PERMISSION_DENIED");
});

// --- the inventory ---------------------------------------------------------

const configured = [
  { label: "Team Meeting", calendarId: "team@group.calendar.google.com" },
  { label: "Informational", calendarId: "info@group.calendar.google.com" },
];

test("an empty inventory rules out a mistyped id and says so", () => {
  const text = describeCalendarInventory(configured, []);
  assert.match(text, /Nothing/);
  // The distinguishing claim: no id could be wrong if nothing is visible.
  assert.match(text, /rules out a mistyped id/);
  assert.match(text, /Workspace/);
});

test("a non-empty inventory missing the configured ids blames the ids", () => {
  const text = describeCalendarInventory(configured, [
    {
      id: "other@group.calendar.google.com",
      summary: "Some Other Calendar",
      accessRole: "reader",
    },
  ]);
  assert.match(text, /not in this list/);
  assert.match(text, /credential and the sharing mechanism both work/);
  // The ids it *can* read have to be printed, so they can be copied.
  assert.match(text, /other@group\.calendar\.google\.com/);
  assert.match(text, /Some Other Calendar/);
});

test("a visible calendar is reported with its access role", () => {
  const text = describeCalendarInventory(configured, [
    {
      id: "team@group.calendar.google.com",
      summary: "Team",
      accessRole: "reader",
    },
  ]);
  assert.match(text, /\*Team Meeting\* — visible \(`reader`\)/);
  assert.match(text, /\*Informational\* — not in this list/);
});

test("an id that matches only after stripping invisible characters is named as such", () => {
  const real = "team@group.calendar.google.com";
  const pasted = real.replace("@", "​@");

  const text = describeCalendarInventory(
    [{ label: "Team Meeting", calendarId: pasted }],
    [{ id: real, summary: "Red Hawk Team Meetings", accessRole: "reader" }]
  );

  assert.match(text, /invisible characters/);
  assert.match(text, /zero-width or non-breaking space/);
  // And it must offer the corrected value, not just diagnose.
  assert.match(text, /config set … team@group\.calendar\.google\.com/);
  // It must NOT be reported as a plain wrong id — that sends you to re-copy
  // an id that is already, visibly, correct.
  assert.doesNotMatch(text, /Team Meeting\* — not in this list/);
});

test("free/busy-only sharing is called out rather than reported as visible", () => {
  const text = describeCalendarInventory(
    [configured[0]!],
    [
      {
        id: "team@group.calendar.google.com",
        summary: "Team",
        accessRole: "freeBusyReader",
      },
    ]
  );
  assert.match(text, /See only free\/busy/);
  assert.match(text, /See all event details/);
});

// --- paging ----------------------------------------------------------------

const event = (id: string) => ({
  id,
  status: "confirmed" as const,
  summary: id,
  start: { dateTime: "2026-01-06T18:00:00.000Z" },
  end: { dateTime: "2026-01-06T20:00:00.000Z" },
});

test("a single page is returned as is", async () => {
  const events = await collectEventPages(async () => ({
    items: [event("a"), event("b")],
  }));
  assert.deepEqual(
    events.map((e) => e.id),
    ["a", "b"]
  );
});

test("every page is followed, in order, and the token is passed back", async () => {
  const tokensSeen: (string | undefined)[] = [];
  const pages = [
    { items: [event("a")], nextPageToken: "p2" },
    { items: [event("b")], nextPageToken: "p3" },
    { items: [event("c")] },
  ];
  let n = 0;
  const events = await collectEventPages(async (pageToken) => {
    tokensSeen.push(pageToken);
    return pages[n++]!;
  });

  assert.deepEqual(
    events.map((e) => e.id),
    ["a", "b", "c"],
    "events past the first page were dropped"
  );
  assert.deepEqual(tokensSeen, [undefined, "p2", "p3"]);
});

test("a page with no items contributes nothing rather than throwing", async () => {
  const events = await collectEventPages(async () => ({}));
  assert.deepEqual(events, []);
});

test("a server that echoes the same page token forever is cut off", async () => {
  let calls = 0;
  await assert.rejects(
    collectEventPages(async () => {
      calls++;
      return { items: [event("a")], nextPageToken: "same" };
    }),
    /more than 20 pages/
  );
  assert.equal(calls, 20, "the backstop should stop paging, not loop");
});

// --- delegation ------------------------------------------------------------

test("the service account's client id is extracted for the delegation grant", () => {
  // It is what an admin pastes into Admin console → Domain-wide delegation,
  // and it exists nowhere else an operator can reach.
  assert.equal(parseServiceAccountKey(encode(validKey)).clientId, "123");
});

test("a key file without a client_id still parses", () => {
  const { client_id: _omitted, ...rest } = validKey;
  const parsed = parseServiceAccountKey(encode(rest));
  assert.equal(parsed.clientId, undefined);
  // Absence must not break authentication — client_id plays no part in it.
  assert.equal(parsed.clientEmail, validKey.client_email);
});

test("without delegation, a 404 names the Workspace trap and points at delegation", () => {
  const text = describeCalendarAccessFailure(
    { status: 404, message: "Not Found", reason: "notFound" },
    ctx
  );
  // The failure we actually hit: dialog shows the entry, Google refuses it.
  assert.match(text, /accept an external principal in the sharing dialog/);
  assert.match(text, /google_impersonated_user/);
});

test("with delegation on, a 404 stops talking about sharing entirely", () => {
  const text = describeCalendarAccessFailure(
    { status: 404, message: "Not Found", reason: "notFound" },
    { ...ctx, impersonating: "calendar@team.org" }
  );
  assert.match(text, /as `calendar@team\.org`/);
  assert.match(text, /calendar\.readonly/);
  // Sharing with the service account is irrelevant once impersonating.
  assert.doesNotMatch(text, /Share with specific people or groups/);
});

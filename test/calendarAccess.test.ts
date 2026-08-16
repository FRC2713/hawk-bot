import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeCalendarAccessFailure,
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
  const text = describeCalendarAccessFailure(404, "Not Found", ctx);
  assert.match(text, /never shared/);
  assert.match(text, /See all event details/);
  // The address to share with has to appear — it is the actionable part.
  assert.match(text, /hawk-bot@hawk-bot\.iam\.gserviceaccount\.com/);
});

test("a 404 still gives the sharing instruction when the email is unknown", () => {
  const text = describeCalendarAccessFailure(404, "Not Found", {
    calendarId: ctx.calendarId,
  });
  assert.match(text, /service account's own email address/);
});

test("a disabled Calendar API is distinguished from a sharing problem", () => {
  const google =
    "Google Calendar API has not been used in project 12345 before or it is disabled. " +
    "Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=12345 then retry.";
  const text = describeCalendarAccessFailure(403, google, ctx);
  assert.match(text, /not enabled in the service account's Cloud project/);
  assert.doesNotMatch(text, /never shared/);
  // Google's message carries the one-click enable link; it must survive.
  assert.match(text, /console\.developers\.google\.com/);
});

test("a plain 403 points at the sharing level rather than at the API", () => {
  const text = describeCalendarAccessFailure(403, "Forbidden", ctx);
  assert.match(text, /free\/busy/);
  assert.doesNotMatch(
    text,
    /not enabled in the service account's Cloud project/
  );
});

test("a rejected assertion points at the key and the clock", () => {
  const text = describeCalendarAccessFailure(
    400,
    "invalid_grant: Invalid JWT Signature.",
    ctx
  );
  assert.match(text, /rejected the service account credential/);
  assert.match(text, /clock/);
});

test("an unrecognized failure is passed through rather than guessed at", () => {
  const text = describeCalendarAccessFailure(500, "Backend Error", ctx);
  assert.equal(text, "Google said: Backend Error");
});

test("status and message are read off either error shape", () => {
  assert.deepEqual(readGoogleError({ status: 404, message: "Not Found" }), {
    status: 404,
    message: "Not Found",
  });
  assert.deepEqual(
    readGoogleError({ response: { status: 403 }, message: "Forbidden" }),
    { status: 403, message: "Forbidden" }
  );
  // A thrown non-Error must not take the diagnostic down with it.
  assert.deepEqual(readGoogleError("boom"), {
    status: undefined,
    message: "boom",
  });
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

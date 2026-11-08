import assert from "node:assert/strict";
import { it } from "node:test";
import { readSuiteHeaders } from "../src/web/suiteSession.js";
const valid = {
  "x-token-subject": "slack:TTEAM:UADMIN",
  "x-hawk-slack-team": "TTEAM",
  "x-hawk-slack-user": "UADMIN",
  "x-token-user-roles": "authp/user suite/member",
};
it("reads a complete matching identity and optional profile", () => {
  assert.deepEqual(
    readSuiteHeaders(
      {
        ...valid,
        "x-token-user-name": " Avery Hawk ",
        "x-token-user-email": "avery@example.invalid",
      },
      "TTEAM"
    ),
    {
      subject: "slack:TTEAM:UADMIN",
      teamId: "TTEAM",
      userId: "UADMIN",
      name: "Avery Hawk",
      email: "avery@example.invalid",
    }
  );
});
it("requires every identity field", () => {
  for (const key of Object.keys(valid)) {
    assert.equal(
      readSuiteHeaders({ ...valid, [key]: undefined }, "TTEAM"),
      undefined,
      key
    );
    assert.equal(
      readSuiteHeaders({ ...valid, [key]: "" }, "TTEAM"),
      undefined,
      key
    );
    assert.equal(
      readSuiteHeaders(
        {
          ...valid,
          [key]: [
            valid[key as keyof typeof valid],
            valid[key as keyof typeof valid],
          ],
        },
        "TTEAM"
      ),
      undefined,
      key
    );
  }
});
it("rejects a foreign workspace, mismatched subject, malformed IDs and role substrings", () => {
  for (const overrides of [
    { "x-hawk-slack-team": "TOTHER" },
    { "x-token-subject": "slack:TTEAM:UOTHER" },
    { "x-token-subject": "admin" },
    { "x-hawk-slack-user": "UADMIN, UOTHER" },
    {
      "x-hawk-slack-user": "UADMIN ",
      "x-token-subject": "slack:TTEAM:UADMIN ",
    },
    { "x-token-user-roles": "suite/member-admin" },
    { "x-token-user-roles": "suite/member, authp/user" },
    { "x-token-user-roles": "admin" },
  ])
    assert.equal(
      readSuiteHeaders({ ...valid, ...overrides }, "TTEAM"),
      undefined
    );
  assert.equal(readSuiteHeaders(valid, "TOTHER"), undefined);
});
it("accepts a single raw header value but ignores oversized or duplicate display fields", () => {
  assert.ok(
    readSuiteHeaders({ ...valid, "x-hawk-slack-user": ["UADMIN"] }, "TTEAM")
  );
  const identity = readSuiteHeaders(
    {
      ...valid,
      "x-token-user-name": "x".repeat(257),
      "x-token-user-email": ["a", "b"],
    },
    "TTEAM"
  );
  assert.ok(identity);
  assert.equal(identity.name, undefined);
  assert.equal(identity.email, undefined);
});

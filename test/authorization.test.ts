import assert from "node:assert/strict";
import { test } from "node:test";
import { isHawkBotAdmin } from "../src/domain/authorization.js";

test("a workspace Owner is always a HawkBot Admin, even outside the group", () => {
  assert.equal(
    isHawkBotAdmin({
      userId: "U1",
      groupMemberIds: new Set(),
      isWorkspaceOwner: true,
    }),
    true
  );
});

test("a non-Owner member of the HawkBot Admin group is a HawkBot Admin", () => {
  assert.equal(
    isHawkBotAdmin({
      userId: "U1",
      groupMemberIds: new Set(["U1", "U2"]),
      isWorkspaceOwner: false,
    }),
    true
  );
});

test("a non-Owner who isn't in the group is not a HawkBot Admin", () => {
  assert.equal(
    isHawkBotAdmin({
      userId: "U3",
      groupMemberIds: new Set(["U1", "U2"]),
      isWorkspaceOwner: false,
    }),
    false
  );
});

test("an empty or unconfigured group still leaves Owners as admins, nobody else", () => {
  assert.equal(
    isHawkBotAdmin({
      userId: "U1",
      groupMemberIds: new Set(),
      isWorkspaceOwner: false,
    }),
    false
  );
  assert.equal(
    isHawkBotAdmin({
      userId: "U1",
      groupMemberIds: new Set(),
      isWorkspaceOwner: true,
    }),
    true
  );
});

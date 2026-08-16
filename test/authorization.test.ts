import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isHawkBotAdmin,
  resolveTeamRole,
} from "../src/domain/authorization.js";

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

test("someone solely in the mentor group resolves to mentor", () => {
  assert.equal(
    resolveTeamRole({
      userId: "U1",
      studentGroupMemberIds: new Set(),
      mentorGroupMemberIds: new Set(["U1"]),
    }),
    "mentor"
  );
});

test("someone solely in the student group resolves to student", () => {
  assert.equal(
    resolveTeamRole({
      userId: "U1",
      studentGroupMemberIds: new Set(["U1"]),
      mentorGroupMemberIds: new Set(),
    }),
    "student"
  );
});

test("someone in both groups resolves to student — the tie-break", () => {
  assert.equal(
    resolveTeamRole({
      userId: "U1",
      studentGroupMemberIds: new Set(["U1"]),
      mentorGroupMemberIds: new Set(["U1"]),
    }),
    "student"
  );
});

test("someone in neither group is skipped", () => {
  assert.equal(
    resolveTeamRole({
      userId: "U1",
      studentGroupMemberIds: new Set(["U2"]),
      mentorGroupMemberIds: new Set(["U3"]),
    }),
    "skipped"
  );
});

test("both groups empty still resolves to skipped, not a default role", () => {
  assert.equal(
    resolveTeamRole({
      userId: "U1",
      studentGroupMemberIds: new Set(),
      mentorGroupMemberIds: new Set(),
    }),
    "skipped"
  );
});

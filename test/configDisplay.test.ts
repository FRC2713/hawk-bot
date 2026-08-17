import assert from "node:assert/strict";
import { test } from "node:test";
import { formatResolvedValue } from "../src/domain/configDisplay.js";

test("a resolved channel shows its name with the # sigil", () => {
  assert.equal(
    formatResolvedValue("C0123456789", "channel", {
      status: "ok",
      name: "general",
    }),
    "C0123456789 (#general)"
  );
});

test("a resolved usergroup shows its handle with the @ sigil", () => {
  assert.equal(
    formatResolvedValue("S0123456789", "usergroup", {
      status: "ok",
      name: "hawkbot-admins",
    }),
    "S0123456789 (@hawkbot-admins)"
  );
});

test("a channel that won't resolve says so, without asserting it's deleted", () => {
  // Slack returns the same code for "deleted" and "private, bot not invited"
  // — the message has to cover both rather than claim certainty.
  assert.match(
    formatResolvedValue("C0123456789", "channel", { status: "not_found" }),
    /^C0123456789 ⚠️ not found/
  );
});

test("a deleted usergroup says so explicitly", () => {
  assert.equal(
    formatResolvedValue("S0123456789", "usergroup", { status: "not_found" }),
    "S0123456789 ⚠️ not found"
  );
});

test("an id the bot can't see is distinguished from a deleted one", () => {
  assert.equal(
    formatResolvedValue("C0123456789", "channel", { status: "no_access" }),
    "C0123456789 ⚠️ no access"
  );
});

test("an unrecognized/transient failure shows the bare id, no annotation", () => {
  assert.equal(
    formatResolvedValue("C0123456789", "channel", { status: "unknown" }),
    "C0123456789"
  );
});

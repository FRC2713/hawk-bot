import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkinPointer,
  resolveCheckinChannel,
  resolveFtcRouting,
} from "../src/domain/ftc.js";

const ANNOUNCE = "CANNOUNCE1";
const FTC = "CFTCCHAN01";
const on: {
  announceChannel: string | undefined;
  ftcMarker: string | undefined;
  ftcChannel: string | undefined;
} = { announceChannel: ANNOUNCE, ftcMarker: "🟧", ftcChannel: FTC };

const route = (title: string, settings = on) =>
  resolveCheckinChannel({ title }, settings);

test("an event led by the marker checks in to the FTC channel", () => {
  assert.equal(route("🟧 FTC Team Meeting (36584 RAS)"), FTC);
  assert.equal(route("  🟧 FTC practice"), FTC);
});

test("a Multi-Day Child title still leads with the marker", () => {
  assert.equal(route("🟧 FTC Regional (Day 1 of 2)"), FTC);
});

test("a joint meeting carrying the marker mid-title stays in announcements", () => {
  assert.equal(
    route("Team Meeting 🟦 🟧 (FRC and FTC 26623 BtheBs)"),
    ANNOUNCE
  );
  assert.equal(route("IMPORTANT: Robotics Student & Parent Meeting"), ANNOUNCE);
});

test("the marker matches case-insensitively", () => {
  const text = { ...on, ftcMarker: "[ftc]" };
  assert.equal(route("[FTC] practice", text), FTC);
  assert.equal(route("[Ftc] practice", text), FTC);
});

test("with the marker or the channel unset, everything goes to announcements", () => {
  const title = "🟧 FTC Team Meeting";
  assert.equal(route(title, { ...on, ftcMarker: undefined }), ANNOUNCE);
  assert.equal(route(title, { ...on, ftcChannel: undefined }), ANNOUNCE);
  assert.equal(
    route(title, { ...on, ftcMarker: undefined, ftcChannel: undefined }),
    ANNOUNCE
  );
});

test("an unset announcements channel yields no channel for a non-FTC event", () => {
  assert.equal(
    route("Team Meeting", { ...on, announceChannel: undefined }),
    undefined
  );
  assert.equal(
    route("🟧 FTC practice", { ...on, announceChannel: undefined }),
    FTC
  );
});

test("a blank marker is off rather than matching every title", () => {
  assert.equal(route("anything", { ...on, ftcMarker: "  " }), ANNOUNCE);
});

test("FTC routing is on only when both settings are set", () => {
  assert.deepEqual(resolveFtcRouting({ marker: "🟧", channel: FTC }), {
    marker: "🟧",
    channel: FTC,
  });
  assert.equal(
    resolveFtcRouting({ marker: "🟧", channel: undefined }),
    undefined
  );
  assert.equal(
    resolveFtcRouting({ marker: undefined, channel: FTC }),
    undefined
  );
  assert.equal(resolveFtcRouting({ marker: " ", channel: FTC }), undefined);
});

const team = (title: string, checkinChannel: string | null = null) => ({
  title,
  calendarRole: "team_meeting",
  checkinChannel,
});

test("a summary line points at the FTC channel for an FTC event", () => {
  assert.equal(checkinPointer(team("🟧 FTC practice"), on), FTC);
});

test("no pointer for an announcements event, a joint meeting, or routing off", () => {
  assert.equal(checkinPointer(team("Team Meeting"), on), undefined);
  assert.equal(
    checkinPointer(team("Team Meeting 🟦 🟧 (FRC and FTC)"), on),
    undefined
  );
  assert.equal(
    checkinPointer(team("🟧 FTC practice"), { ...on, ftcChannel: undefined }),
    undefined
  );
});

test("once the post is out its recorded channel wins", () => {
  assert.equal(checkinPointer(team("🟧 FTC practice", FTC), on), FTC);
  assert.equal(
    checkinPointer(team("🟧 FTC practice", ANNOUNCE), on),
    undefined
  );
});

test("only Team Meeting events get a pointer", () => {
  assert.equal(
    checkinPointer(
      { ...team("🟧 FTC practice"), calendarRole: "informational" },
      on
    ),
    undefined
  );
});

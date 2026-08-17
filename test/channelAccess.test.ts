import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode, type WebAPIPlatformError } from "@slack/web-api";
import { describeChannelAccessError } from "../src/slack/channelAccess.js";

function platformError(error: string): WebAPIPlatformError {
  return {
    code: ErrorCode.PlatformError,
    name: "PlatformError",
    message: `An API error occurred: ${error}`,
    data: { ok: false, error } as WebAPIPlatformError["data"],
  };
}

test("a known channel-access error gets an actionable, specific description", () => {
  assert.match(
    describeChannelAccessError(platformError("not_in_channel")) ?? "",
    /invite Hawk Bot/
  );
  assert.match(
    describeChannelAccessError(platformError("missing_scope")) ?? "",
    /reinstall the app/
  );
  assert.match(
    describeChannelAccessError(platformError("channel_not_found")) ?? "",
    /channel id doesn't exist/
  );
});

test("an unrecognized platform error is left for the caller's generic fallback", () => {
  assert.equal(
    describeChannelAccessError(platformError("rate_limited")),
    undefined
  );
});

test("a non-Slack error is left for the caller's generic fallback", () => {
  assert.equal(describeChannelAccessError(new Error("boom")), undefined);
  assert.equal(describeChannelAccessError("boom"), undefined);
  assert.equal(describeChannelAccessError(undefined), undefined);
});

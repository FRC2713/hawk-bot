import assert from "node:assert/strict";
import { test } from "node:test";
import { ErrorCode, type WebAPIPlatformError } from "@slack/web-api";
import { describeNameResolutionError } from "../src/slack/nameResolution.js";

function platformError(error: string): WebAPIPlatformError {
  return {
    code: ErrorCode.PlatformError,
    name: "PlatformError",
    message: `An API error occurred: ${error}`,
    data: { ok: false, error } as WebAPIPlatformError["data"],
  };
}

test("a channel that no longer exists maps to not_found", () => {
  assert.equal(
    describeNameResolutionError(platformError("channel_not_found")),
    "not_found"
  );
});

test("a missing scope or channel the bot isn't in maps to no_access", () => {
  assert.equal(
    describeNameResolutionError(platformError("missing_scope")),
    "no_access"
  );
  assert.equal(
    describeNameResolutionError(platformError("not_in_channel")),
    "no_access"
  );
});

test("an unrecognized platform error is left for the caller's unknown fallback", () => {
  assert.equal(
    describeNameResolutionError(platformError("rate_limited")),
    undefined
  );
});

test("a non-Slack error is left for the caller's unknown fallback", () => {
  assert.equal(describeNameResolutionError(new Error("boom")), undefined);
  assert.equal(describeNameResolutionError("boom"), undefined);
  assert.equal(describeNameResolutionError(undefined), undefined);
});

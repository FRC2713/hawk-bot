import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCookies,
  serializeCookie,
  signSession,
  signState,
  verifySession,
  verifyState,
  type WebSession,
} from "../src/web/session.js";

const SECRET = "test-secret-at-least-sixteen";
const NOW = 1_700_000_000_000;

const session: WebSession = {
  userId: "U0123456789",
  teamId: "T0123456789",
  name: "Ty",
  exp: NOW + 60_000,
};

describe("web session tokens", () => {
  it("round-trips a session", () => {
    const token = signSession(session, SECRET);
    assert.deepEqual(verifySession(token, SECRET, NOW), session);
  });

  it("rejects an expired session", () => {
    const token = signSession(session, SECRET);
    assert.equal(verifySession(token, SECRET, session.exp), undefined);
  });

  it("rejects a tampered payload", () => {
    const token = signSession(session, SECRET);
    const [payload = "", mac = ""] = token.split(".");
    const forged = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as WebSession;
    forged.userId = "UEVIL";
    const forgedPayload = Buffer.from(JSON.stringify(forged)).toString(
      "base64url"
    );
    assert.equal(
      verifySession(`${forgedPayload}.${mac}`, SECRET, NOW),
      undefined
    );
  });

  it("rejects a token signed with a different secret", () => {
    const token = signSession(session, "some-other-secret-entirely");
    assert.equal(verifySession(token, SECRET, NOW), undefined);
  });

  it("rejects garbage", () => {
    assert.equal(verifySession("", SECRET, NOW), undefined);
    assert.equal(verifySession("not-a-token", SECRET, NOW), undefined);
    assert.equal(verifySession("a.b.c", SECRET, NOW), undefined);
  });

  it("a state token is not accepted as a session", () => {
    const token = signState("random", NOW + 60_000, SECRET);
    assert.equal(verifySession(token, SECRET, NOW), undefined);
  });
});

describe("oauth state tokens", () => {
  it("round-trips within its lifetime", () => {
    const token = signState("abc123", NOW + 600_000, SECRET);
    assert.equal(verifyState(token, SECRET, NOW), "abc123");
  });

  it("expires", () => {
    const token = signState("abc123", NOW - 1, SECRET);
    assert.equal(verifyState(token, SECRET, NOW), undefined);
  });

  it("a session token is not accepted as state", () => {
    const token = signSession(session, SECRET);
    assert.equal(verifyState(token, SECRET, NOW), undefined);
  });
});

describe("cookies", () => {
  it("parses a header, skipping malformed pairs", () => {
    const cookies = parseCookies("a=1; hb_session=x.y; =bad; noeq; b=2");
    assert.equal(cookies.get("a"), "1");
    assert.equal(cookies.get("hb_session"), "x.y");
    assert.equal(cookies.get("b"), "2");
    assert.equal(cookies.size, 3);
  });

  it("handles a missing header", () => {
    assert.equal(parseCookies(undefined).size, 0);
  });

  it("serializes with the expected attributes", () => {
    assert.equal(
      serializeCookie("hb_session", "tok", { maxAgeSeconds: 60, secure: true }),
      "hb_session=tok; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure"
    );
    assert.equal(
      serializeCookie("hb_session", "", { maxAgeSeconds: 0, secure: false }),
      "hb_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chooseWebSession,
  parseCookies,
  serializeCookie,
  signSession,
  signState,
  verifySession,
  verifyState,
  type SessionCandidate,
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

describe("choosing between the two doors", () => {
  const installed = "T0123456789";
  const own: SessionCandidate = {
    identity: { userId: "UOWN", teamId: installed, name: "Ty" },
    viaSuite: false,
  };
  const suite: SessionCandidate = {
    identity: { userId: "USUITE", teamId: installed, name: "Ty via Suite" },
    viaSuite: true,
  };
  const foreign = (viaSuite: boolean): SessionCandidate => ({
    identity: { userId: "UELSE", teamId: "TOTHER", name: "Someone Else" },
    viaSuite,
  });

  it("offers sign-in when no session verified at all", () => {
    assert.deepEqual(chooseWebSession([], installed), { kind: "sign-in" });
  });

  it("uses hawk-bot's own session when it is the only one", () => {
    assert.deepEqual(chooseWebSession([own], installed), {
      kind: "use",
      identity: own.identity,
      viaSuite: false,
    });
  });

  it("prefers the gateway's session when both are valid", () => {
    // Caller order is the preference, and routes.ts passes the gateway first:
    // it is the shorter-lived cookie and the one whose sign-out link works.
    assert.deepEqual(chooseWebSession([suite, own], installed), {
      kind: "use",
      identity: suite.identity,
      viaSuite: true,
    });
  });

  it("falls through to a usable session when the preferred one is foreign", () => {
    // Each cookie is judged against the installed team on its own: the
    // gateway's configuration is the gateway's, not hawk-bot's.
    assert.deepEqual(chooseWebSession([foreign(true), own], installed), {
      kind: "use",
      identity: own.identity,
      viaSuite: false,
    });
  });

  it("is terminal — never sign-in — when every session is foreign", () => {
    // The gateway issued the cookie that just failed, so a bounce back there
    // would loop with no exit.
    const choice = chooseWebSession([foreign(true), foreign(false)], installed);
    assert.equal(choice.kind, "wrong-workspace");
    assert.equal(
      choice.kind === "wrong-workspace" && choice.identity.name,
      "Someone Else"
    );
    assert.equal(choice.kind === "wrong-workspace" && choice.viaSuite, true);
  });
});

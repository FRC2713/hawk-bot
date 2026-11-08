import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { describe, it } from "node:test";
import {
  suitePublicKey,
  SUITE_COOKIE,
  SUITE_MEMBER_ROLE,
  verifySuiteToken,
} from "../src/web/suiteSession.js";

/**
 * The gateway's half of this contract is hawk_suite's
 * `config/authentication/Caddyfile.template`: an RS* JWT in
 * `AUTHP_ACCESS_TOKEN` carrying `sub: slack:<team>:<user>`, `roles` including
 * `suite/member`, `iss: https://apps.<domain>/` and `aud: hawk-suite`. These
 * tests sign their own tokens to that shape, so a change at either end shows
 * up as a failure here rather than as a page that lets the wrong person in.
 */

const ISSUER = "https://apps.suite.test/";
const AUDIENCE = "hawk-suite";
const NOW = 1_700_000_000_000;

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

const verifier = { issuer: ISSUER, audience: AUDIENCE, key: pair.publicKey };

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function token(
  options: {
    claims?: Record<string, unknown>;
    alg?: "RS256" | "RS384" | "RS512";
    key?: KeyObject;
  } = {}
): string {
  const alg = options.alg ?? "RS256";
  const hash = { RS256: "sha256", RS384: "sha384", RS512: "sha512" }[alg];
  const head = b64({ alg, typ: "JWT" });
  const body = b64({
    sub: "slack:TTEAM:UADMIN",
    roles: [SUITE_MEMBER_ROLE, "authp/user"],
    iss: ISSUER,
    aud: AUDIENCE,
    iat: NOW / 1000 - 1,
    exp: NOW / 1000 + 900,
    ...options.claims,
  });
  const mac = sign(
    hash,
    Buffer.from(`${head}.${body}`),
    options.key ?? pair.privateKey
  ).toString("base64url");
  return `${head}.${body}.${mac}`;
}

/**
 * The head and body of an otherwise perfect token, for the two classic
 * forgeries: the caller supplies whatever it can pass off as a signature.
 */
function unsigned(alg: string): { head: string; body: string } {
  return {
    head: b64({ alg, typ: "JWT" }),
    body: b64({
      sub: "slack:TTEAM:UEVIL",
      roles: [SUITE_MEMBER_ROLE],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW / 1000 + 900,
    }),
  };
}

describe("the suite gateway's session", () => {
  it("accepts a signed workspace member and reads both Slack ids", () => {
    assert.deepEqual(verifySuiteToken(token(), verifier, NOW), {
      userId: "UADMIN",
      teamId: "TTEAM",
      subject: "slack:TTEAM:UADMIN",
    });
  });

  it("carries the optional display name when the gateway signed one", () => {
    const named = token({ claims: { name: "Ty Tremblay" } });
    assert.equal(verifySuiteToken(named, verifier, NOW)?.name, "Ty Tremblay");
    // Display only: a non-string name is dropped, not a reason to refuse.
    const odd = token({ claims: { name: { first: "Ty" } } });
    const identity = verifySuiteToken(odd, verifier, NOW);
    assert.equal(identity?.name, undefined);
    assert.equal(identity?.userId, "UADMIN");
  });

  it("accepts the other two RSA hashes the gateway may sign with", () => {
    for (const alg of ["RS384", "RS512"] as const) {
      assert.equal(
        verifySuiteToken(token({ alg }), verifier, NOW)?.userId,
        "UADMIN",
        alg
      );
    }
  });

  it("accepts a W user id — Slack issues those too", () => {
    const t = token({ claims: { sub: "slack:TTEAM:WLEGACY" } });
    assert.equal(verifySuiteToken(t, verifier, NOW)?.userId, "WLEGACY");
  });

  it("rejects another key's signature", () => {
    assert.equal(
      verifySuiteToken(token({ key: other.privateKey }), verifier, NOW),
      undefined
    );
  });

  it("rejects a tampered payload", () => {
    const good = token();
    const [head, , mac] = good.split(".");
    const swapped = b64({
      sub: "slack:TTEAM:UEVIL",
      roles: [SUITE_MEMBER_ROLE],
      iss: ISSUER,
      aud: AUDIENCE,
      exp: NOW / 1000 + 900,
    });
    assert.equal(
      verifySuiteToken(`${head}.${swapped}.${mac}`, verifier, NOW),
      undefined
    );
    // The untampered token still verifies, so this cannot pass vacuously.
    assert.ok(verifySuiteToken(good, verifier, NOW));
  });

  it("refuses alg:none — an unsigned token is not a session", () => {
    const { head, body } = unsigned("none");
    for (const mac of ["", "x"]) {
      assert.equal(
        verifySuiteToken(`${head}.${body}.${mac}`, verifier, NOW),
        undefined,
        `signature ${JSON.stringify(mac)}`
      );
    }
  });

  it("refuses HS256 signed with the published public key", () => {
    // The verification key is public, so an HMAC keyed with it is something
    // anyone can compute — which is why only RSA is on the allowlist.
    const { head, body } = unsigned("HS256");
    const mac = createHmac("sha256", pem)
      .update(`${head}.${body}`)
      .digest("base64url");
    assert.equal(
      verifySuiteToken(`${head}.${body}.${mac}`, verifier, NOW),
      undefined
    );
  });

  it("rejects an expired token, to the second", () => {
    const t = token({ claims: { exp: NOW / 1000 } });
    assert.equal(verifySuiteToken(t, verifier, NOW), undefined);
    assert.ok(verifySuiteToken(t, verifier, NOW - 1000));
  });

  it("rejects a token with no expiry at all", () => {
    assert.equal(
      verifySuiteToken(token({ claims: { exp: undefined } }), verifier, NOW),
      undefined
    );
  });

  it("honours not-before", () => {
    const t = token({ claims: { nbf: NOW / 1000 + 60 } });
    assert.equal(verifySuiteToken(t, verifier, NOW), undefined);
    assert.ok(verifySuiteToken(t, verifier, NOW + 60_000));
  });

  it("rejects another issuer or another audience", () => {
    assert.equal(
      verifySuiteToken(
        token({ claims: { iss: "https://apps.evil.test/" } }),
        verifier,
        NOW
      ),
      undefined
    );
    assert.equal(
      verifySuiteToken(token({ claims: { aud: "hawk-eye" } }), verifier, NOW),
      undefined
    );
  });

  it("accepts an audience list containing ours", () => {
    const t = token({ claims: { aud: ["other", AUDIENCE] } });
    assert.ok(verifySuiteToken(t, verifier, NOW));
  });

  it("rejects a signed-in non-member", () => {
    // The gateway's portal blocks these, but the role is the half it signed,
    // and hawk-bot checks what it can verify rather than what it was told.
    for (const roles of [[], ["authp/user"], SUITE_MEMBER_ROLE, undefined]) {
      assert.equal(
        verifySuiteToken(token({ claims: { roles } }), verifier, NOW),
        undefined,
        String(roles)
      );
    }
  });

  it("rejects a subject that is not a Slack identity", () => {
    for (const sub of [
      "UADMIN",
      "slack:TTEAM",
      "slack:TTEAM:XADMIN",
      "slack:team:UADMIN",
      "slack:TTEAM:UADMIN:extra",
      "x slack:TTEAM:UADMIN",
      "",
      42,
      undefined,
    ]) {
      assert.equal(
        verifySuiteToken(token({ claims: { sub } }), verifier, NOW),
        undefined,
        String(sub)
      );
    }
  });

  it("rejects garbage without throwing", () => {
    for (const junk of [
      "",
      ".",
      "..",
      "a.b",
      "a.b.c.d",
      "not-a-token",
      "e30.e30.", // valid base64url segments, no algorithm
      `${"x".repeat(9000)}.y.z`,
    ]) {
      assert.equal(
        verifySuiteToken(junk, verifier, NOW),
        undefined,
        junk.slice(0, 12)
      );
    }
  });

  it("refuses a token longer than any the gateway signs", () => {
    // Padding a legitimate token past the cap is refused before any parsing.
    const padded = `${token()}${"A".repeat(8192)}`;
    assert.equal(verifySuiteToken(padded, verifier, NOW), undefined);
  });
});

describe("the gateway's public key", () => {
  it("reads a PEM and the base64 of one, and caches by source", () => {
    assert.equal(suitePublicKey(pem).asymmetricKeyType, "rsa");
    const encoded = Buffer.from(pem).toString("base64");
    assert.equal(suitePublicKey(encoded).asymmetricKeyType, "rsa");
    assert.equal(suitePublicKey(pem), suitePublicKey(pem));
  });

  it("refuses a key that is not RSA, so a bad one fails at boot", () => {
    const ed = generateKeyPairSync("ed25519");
    const edPem = ed.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    assert.throws(() => suitePublicKey(edPem), /RSA public key/);
    assert.throws(() => suitePublicKey("not a key at all"));
  });
});

describe("the cookie name", () => {
  it("is the gateway's, matched exactly", () => {
    assert.equal(SUITE_COOKIE, "AUTHP_ACCESS_TOKEN");
  });
});

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { config } from "../src/config.js";

/**
 * `HAWK_SUITE_*` is checked where every other credential is: once, at
 * `config()`. Half-configured and a key that is not an RSA public key both
 * have to refuse at boot — the alternative is a gateway session that looks
 * verified and is not, or every HawkBot Admin denied at the door with the
 * reason buried in a request log.
 *
 * `config()` caches only a successful parse, so the failures below may run
 * before the acceptance at the end. Node's test runner gives this file its own
 * process, so the cache does not leak into any other test.
 */

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

function env(extra: Record<string, string | undefined>): void {
  Object.assign(process.env, {
    SLACK_SIGNING_SECRET: "s",
    SLACK_CLIENT_ID: "c",
    SLACK_CLIENT_SECRET: "cs",
    SLACK_STATE_SECRET: "0123456789abcdef",
    PUBLIC_URL: "https://bot.suite.test",
    TOKEN_ENCRYPTION_KEY: "k",
    GOOGLE_SERVICE_ACCOUNT_KEY_BASE64: "e30=",
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("the suite gateway's environment", () => {
  it("refuses an issuer with no key", () => {
    env({
      HAWK_SUITE_ISSUER: "https://apps.suite.test/",
      HAWK_SUITE_PUBLIC_KEY: undefined,
    });
    assert.throws(config, /HAWK_SUITE_ISSUER and HAWK_SUITE_PUBLIC_KEY/);
  });

  it("refuses a key with no issuer", () => {
    env({ HAWK_SUITE_ISSUER: undefined, HAWK_SUITE_PUBLIC_KEY: pem });
    assert.throws(config, /HAWK_SUITE_ISSUER and HAWK_SUITE_PUBLIC_KEY/);
  });

  it("refuses a key that is not an RSA public key", () => {
    env({
      HAWK_SUITE_ISSUER: "https://apps.suite.test/",
      HAWK_SUITE_PUBLIC_KEY: "-----BEGIN PUBLIC KEY----- nope",
    });
    assert.throws(config, /not an RSA public key/);
  });

  it("refuses an issuer that is not a URL", () => {
    env({ HAWK_SUITE_ISSUER: "apps.suite.test", HAWK_SUITE_PUBLIC_KEY: pem });
    assert.throws(config, /HAWK_SUITE_ISSUER/);
  });

  it("a blank issuer is unset, so a key alone still refuses", () => {
    // Compose renders an unset variable as an empty string often enough that
    // "" and "  " have to mean the same as absent — and when only one of the
    // pair survives that trimming, half-configured is still half-configured.
    env({ HAWK_SUITE_ISSUER: "  ", HAWK_SUITE_PUBLIC_KEY: pem });
    assert.throws(config, /HAWK_SUITE_ISSUER and HAWK_SUITE_PUBLIC_KEY/);
  });

  it("accepts neither — the gateway is optional, and off by default", () => {
    // Last on purpose: `config()` caches a successful parse, and this file's
    // other cases all expect a throw, which caches nothing. This is the shape
    // every local run and every host without the suite boots with.
    env({
      HAWK_SUITE_ISSUER: undefined,
      HAWK_SUITE_PUBLIC_KEY: undefined,
      HAWK_SUITE_AUDIENCE: undefined,
    });
    const cfg = config();
    assert.equal(cfg.HAWK_SUITE_ISSUER, undefined);
    assert.equal(cfg.HAWK_SUITE_PUBLIC_KEY, undefined);
    // Defaulted whether or not the gateway is in use; it is only read when
    // the issuer and the key are both present.
    assert.equal(cfg.HAWK_SUITE_AUDIENCE, "hawk-suite");
  });
});

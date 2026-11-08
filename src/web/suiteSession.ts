import { createPublicKey, type KeyObject, verify } from "node:crypto";

/**
 * hawk_suite's gateway session, verified here rather than trusted.
 *
 * The suite's Caddy gateway signs people in with Slack once, at
 * `https://apps.<domain>/auth/`, and sets a signed session cookie scoped to the
 * bare domain — so a browser that reaches `bot.<domain>` at all has already
 * passed that gate, and every subdomain's request carries the same cookie. That
 * cookie, `AUTHP_ACCESS_TOKEN`, is the identity: an RS256/384/512 JWT whose
 * public key arrives as `HAWK_SUITE_PUBLIC_KEY`.
 *
 * **An identity header is never trusted.** The gateway strips a client-supplied
 * `X-Hawk-Identity` on the way in, but a header is only as honest as every hop
 * in front of it, and hawk-bot is also reachable directly on the Docker
 * network, where there is no gateway in front of anything. A signature is
 * checked by the holder and needs no hop to be honest. hawk-eye made the same
 * choice against the same gateway, and the suite documents it as the contract.
 *
 * **Suite membership is not hawk-bot's authority.** The gateway admits every
 * member of the workspace. This answers *who is asking* — exactly as much as
 * hawk-bot's own Sign in with Slack answers (ADR-0015) — and nothing more.
 * Whether that person may change a setting is still `isHawkBotAdmin()`, run
 * live per request (ADR-0004). See CLAUDE.md, "A second door to the same
 * lock".
 *
 * Pure and deliberately dependency-free: the key, the clock, and the token all
 * arrive as arguments, so the tests sign their own tokens with `node:crypto`
 * and there is no JWT library to keep current.
 */

/** The gateway's cookie, set for the bare domain so every app sees it. */
export const SUITE_COOKIE = "AUTHP_ACCESS_TOKEN";

/** The role the gateway's portal transform grants a workspace member. */
export const SUITE_MEMBER_ROLE = "suite/member";

/** Longer than any token the gateway signs; a 15-minute session is ~1 KB. */
const MAX_TOKEN_BYTES = 8192;

/**
 * Only RSA, and only PKCS#1 v1.5. **An allowlist, load-bearing:** the
 * alternative is reading `alg` out of the token and believing it, and that is
 * exactly what makes the two classic forgeries work — `alg: none`, and an
 * `HS256` token whose HMAC key is the published (non-secret) verification key.
 * Naming the permitted algorithms is what refuses both.
 */
const ALGORITHMS = new Map([
  ["RS256", "sha256"],
  ["RS384", "sha384"],
  ["RS512", "sha512"],
]);

/**
 * `slack:<team>:<user>` — the subject the gateway builds from the identity it
 * verified against Slack's UserInfo endpoint. Both Slack ids are read back out
 * of it rather than out of sibling claims, because this is the one shape the
 * gateway's own tests pin.
 */
const SUBJECT = /^slack:(T[A-Z0-9]+):([UW][A-Z0-9]+)$/;

export type SuiteIdentity = {
  userId: string;
  teamId: string;
  /** The `sub` claim as signed, for the log. */
  subject: string;
  /**
   * The gateway's optional `name` claim — display only, and absent whenever
   * the portal has no profile name to put there. It never affects access.
   */
  name?: string;
};

export type SuiteVerifier = {
  /** `HAWK_SUITE_ISSUER`, matched exactly — `https://apps.<domain>/`. */
  issuer: string;
  /** `HAWK_SUITE_AUDIENCE`, `hawk-suite` unless the gateway is reconfigured. */
  audience: string;
  key: KeyObject;
};

const keyCache = new Map<string, KeyObject>();

/**
 * The gateway's public key, from a PEM or the base64 of one (the suite's deploy
 * workflow renders base64 on a single line). Throws on anything that is not an
 * RSA public key, which is why `config()` calls this at parse time: a mistyped
 * key should refuse to boot, not quietly deny every administrator at the door.
 *
 * Cached by source string, so the request path never re-parses.
 */
export function suitePublicKey(source: string): KeyObject {
  const cached = keyCache.get(source);
  if (cached) return cached;
  const pem = source.includes("-----BEGIN")
    ? source
    : Buffer.from(source, "base64").toString("utf8");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("HAWK_SUITE_PUBLIC_KEY must be an RSA public key");
  }
  keyCache.set(source, key);
  return key;
}

function segment(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8")
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** JWT allows a bare string or a list; the gateway writes a string. */
function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === "string") return claim === expected;
  return Array.isArray(claim) && claim.includes(expected);
}

/**
 * The verified signed-in member, or `undefined` for anything else — missing,
 * malformed, expired, forged, foreign, or non-member. One uninformative
 * `undefined` for every failure on purpose: the browser gets the same page
 * either way, and no caller can accidentally read "could not verify" as a pass.
 *
 * @param nowMs Unix milliseconds.
 */
export function verifySuiteToken(
  token: string,
  verifier: SuiteVerifier,
  nowMs: number
): SuiteIdentity | undefined {
  if (!token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const rawHeader = parts[0] ?? "";
  const rawPayload = parts[1] ?? "";
  const rawSignature = parts[2] ?? "";

  const header = segment(rawHeader);
  const hash =
    typeof header?.alg === "string" ? ALGORITHMS.get(header.alg) : undefined;
  if (!hash) return undefined;

  let signed: boolean;
  try {
    signed = verify(
      hash,
      Buffer.from(`${rawHeader}.${rawPayload}`),
      verifier.key,
      Buffer.from(rawSignature, "base64url")
    );
  } catch {
    return undefined;
  }
  if (!signed) return undefined;

  const claims = segment(rawPayload);
  if (!claims) return undefined;

  // Required, all of them. An unsigned expiry is the whole point of the
  // signature, and a token with no `exp` at all would be a permanent one.
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) {
    return undefined;
  }
  if (typeof claims.nbf === "number" && claims.nbf * 1000 > nowMs) {
    return undefined;
  }
  if (claims.iss !== verifier.issuer) return undefined;
  if (!audienceMatches(claims.aud, verifier.audience)) return undefined;

  // A member of the workspace the gateway was configured for. The portal
  // blocks anyone else, and this role is the half of that it signed — which
  // is the half hawk-bot can check for itself.
  if (
    !Array.isArray(claims.roles) ||
    !claims.roles.includes(SUITE_MEMBER_ROLE)
  ) {
    return undefined;
  }

  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const match = SUBJECT.exec(subject);
  const teamId = match?.[1];
  const userId = match?.[2];
  if (!teamId || !userId) return undefined;
  const name = typeof claims.name === "string" ? claims.name : undefined;
  return { userId, teamId, subject, ...(name ? { name } : {}) };
}

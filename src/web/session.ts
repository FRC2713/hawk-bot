import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed tokens for the web configuration page: the session cookie an admin
 * carries after Sign in with Slack, and the short-lived state token that ties
 * an OAuth callback to the browser that started it.
 *
 * Stateless on purpose — the token *is* the session, HMAC-signed with
 * SLACK_STATE_SECRET (passed in, never read here, so tests need no
 * environment). Nothing about a web session is ever written to the database:
 * what a session proves is "Slack said this is user U in team T until time
 * exp", and that claim expires on its own.
 *
 * Each token kind signs a distinct purpose string, so a state token can never
 * be replayed as a session cookie even though both are minted from the same
 * secret.
 */

export type WebSession = {
  userId: string;
  teamId: string;
  /** Display name from Sign in with Slack, for the "signed in as" line. */
  name: string;
  /** Unix milliseconds. */
  exp: number;
};

function hmac(purpose: string, payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`${purpose}.${payload}`).digest();
}

function sign(purpose: string, value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const mac = hmac(purpose, payload, secret).toString("base64url");
  return `${payload}.${mac}`;
}

function verify(
  purpose: string,
  token: string,
  secret: string
): unknown | undefined {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = hmac(purpose, payload, secret);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function signSession(session: WebSession, secret: string): string {
  return sign("session", session, secret);
}

export function verifySession(
  token: string,
  secret: string,
  nowMs: number
): WebSession | undefined {
  const value = verify("session", token, secret) as WebSession | undefined;
  if (!value || typeof value !== "object") return undefined;
  const { userId, teamId, name, exp } = value;
  if (
    typeof userId !== "string" ||
    typeof teamId !== "string" ||
    typeof name !== "string" ||
    typeof exp !== "number" ||
    exp <= nowMs
  ) {
    return undefined;
  }
  return { userId, teamId, name, exp };
}

/* --------------------------------------------------------- which session */

/**
 * Who a verified session says is asking — the part every door agrees on. A
 * `WebSession` is one; hawk_suite's gateway cookie yields another, with its own
 * expiry already checked by the time it gets here (web/suiteSession.ts), which
 * is why there is no `exp` to fake on this shape.
 */
export type WebIdentity = Pick<WebSession, "userId" | "teamId" | "name">;

/** A verified identity a request arrived with. `viaSuite` marks hawk_suite's
 * gateway cookie; otherwise it is hawk-bot's own session. */
export type SessionCandidate = { identity: WebIdentity; viaSuite: boolean };

export type SessionChoice =
  /** Ask `isHawkBotAdmin()` about this one. */
  | { kind: "use"; identity: WebIdentity; viaSuite: boolean }
  /** Signed in, but to a workspace this app is not installed in. */
  | { kind: "wrong-workspace"; identity: WebIdentity; viaSuite: boolean }
  /** Nothing to go on; offer sign-in. */
  | { kind: "sign-in" };

/**
 * Which verified session answers this request, given that there are now two
 * doors to it (hawk-bot's own Sign in with Slack, and hawk_suite's gateway
 * cookie — web/suiteSession.ts). Pure, and kept out of the handler, because
 * two of the three outcomes are policy rather than plumbing:
 *
 * - A session for some other workspace is a stranger with a Slack account,
 *   whatever their own workspace makes them. The gateway admits only the team
 *   it was configured for, but that is its configuration and not hawk-bot's,
 *   so each cookie is judged on its own against the installed team and either
 *   one may turn out to be the usable door.
 * - "Wrong workspace" has to be terminal — never a bounce back to sign-in.
 *   The gateway issued the cookie that just failed, so sending the browser
 *   there is a loop with no exit.
 *
 * Candidates are tried in order; pass the gateway's first, as it is the
 * shorter-lived cookie and the one whose sign-out link actually ends the
 * session it holds.
 */
export function chooseWebSession(
  candidates: readonly SessionCandidate[],
  installedTeamId: string
): SessionChoice {
  const usable = candidates.find((c) => c.identity.teamId === installedTeamId);
  if (usable) {
    return {
      kind: "use",
      identity: usable.identity,
      viaSuite: usable.viaSuite,
    };
  }
  const first = candidates[0];
  return first
    ? {
        kind: "wrong-workspace",
        identity: first.identity,
        viaSuite: first.viaSuite,
      }
    : { kind: "sign-in" };
}

/**
 * The OAuth state round-trip: minted into a cookie when the sign-in redirect
 * leaves, required back — via both the cookie and Slack's `state` query
 * parameter — when the callback returns. `value` is caller-supplied
 * randomness; the signature and expiry are what make it unforgeable and
 * short-lived.
 */
export function signState(
  value: string,
  expMs: number,
  secret: string
): string {
  return sign("oauth-state", { value, exp: expMs }, secret);
}

export function verifyState(
  token: string,
  secret: string,
  nowMs: number
): string | undefined {
  const parsed = verify("oauth-state", token, secret) as
    { value?: unknown; exp?: unknown } | undefined;
  if (!parsed || typeof parsed !== "object") return undefined;
  if (typeof parsed.value !== "string" || typeof parsed.exp !== "number") {
    return undefined;
  }
  return parsed.exp > nowMs ? parsed.value : undefined;
}

/* ---------------------------------------------------------------- cookies */

/** `cookie` header → name/value map. Malformed pairs are simply skipped. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

/**
 * A Set-Cookie value. HttpOnly and SameSite=Lax always: no script ever needs
 * these cookies, and Lax is half of the CSRF story (the Origin check in
 * web/routes.ts is the other half). `secure` follows PUBLIC_URL's scheme so
 * local HTTP development still works. `maxAgeSeconds: 0` deletes.
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSeconds: number; secure: boolean; path?: string }
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

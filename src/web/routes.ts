import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CustomRoute } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { anyInstallation, listSettings } from "../db/repo.js";
import { formatResolvedValue } from "../domain/configDisplay.js";
import { SETTINGS } from "../domain/settings.js";
import { log } from "../logger.js";
import { isHawkBotAdmin } from "../slack/authz.js";
import { resolveName } from "../slack/nameResolution.js";
import {
  applySettingInput,
  applySettingUnset,
} from "../slack/settingsWrite.js";
import {
  configPage,
  errorPage,
  forbiddenPage,
  landingPage,
  notInstalledPage,
  signInPage,
  type Flash,
  type SettingView,
} from "./pages.js";
import {
  parseCookies,
  serializeCookie,
  signSession,
  signState,
  verifySession,
  verifyState,
  type WebSession,
} from "./session.js";

/**
 * The web surface behind `bot.<domain>`: a landing page, and a configuration
 * page for the same workspace settings as `/hawkbot config`.
 *
 * Sign in with Slack (OpenID Connect) answers "who is this browser" — and
 * that is *all* it answers. The scopes are `openid profile`, which grant
 * identity, not access: the token Slack hands back can call
 * `openid.connect.userInfo` and nothing else, is used for exactly that one
 * call, and is never stored or logged. What a signed-in person may *do* is
 * then decided by the same HawkBot Admin check every admin command goes
 * through (slack/authz.ts). See ADR-0015.
 *
 * CSRF: session cookies are SameSite=Lax, and every state-changing POST also
 * requires an Origin header matching PUBLIC_URL.
 */

export const OIDC_SCOPES = "openid profile";

const SESSION_COOKIE = "hawk_bot_session";
const STATE_COOKIE = "hawk_bot_oauth_state";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function isSecure(): boolean {
  return new URL(config().PUBLIC_URL).protocol === "https:";
}

function sendHtml(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function redirect(
  res: ServerResponse,
  location: string,
  cookies: string[] = []
): void {
  res.writeHead(303, {
    location,
    "cache-control": "no-store",
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  });
  res.end();
}

function currentSession(req: IncomingMessage): WebSession | undefined {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  if (!token) return undefined;
  return verifySession(token, config().SLACK_STATE_SECRET, Date.now());
}

/** The installed workspace's bot client — the same pattern as scheduler.ts. */
function installedWorkspace():
  { client: WebClient; teamId: string } | undefined {
  const installation = anyInstallation();
  if (!installation) return undefined;
  const payload = installation.payload as { bot?: { token?: string } };
  const token = payload.bot?.token;
  if (!token) return undefined;
  return { client: new WebClient(token), teamId: installation.teamId };
}

/**
 * The session-and-authorization gate in front of the configuration page and
 * both of its POSTs. Writes the appropriate page and returns undefined when
 * the caller should stop; the session's team must be the installed team, so
 * a sign-in from some other Slack workspace proves nothing here.
 */
async function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ session: WebSession; client: WebClient } | undefined> {
  const session = currentSession(req);
  if (!session) {
    sendHtml(res, 200, signInPage());
    return undefined;
  }
  const installed = installedWorkspace();
  if (!installed) {
    sendHtml(res, 200, notInstalledPage());
    return undefined;
  }
  if (session.teamId !== installed.teamId) {
    sendHtml(res, 403, forbiddenPage(session.name));
    return undefined;
  }
  if (!(await isHawkBotAdmin(installed.client, session.userId))) {
    sendHtml(res, 403, forbiddenPage(session.name));
    return undefined;
  }
  return { session, client: installed.client };
}

/**
 * SameSite=Lax stops a cross-site form from carrying the session cookie, but
 * only in browsers that enforce it — this check is the belt to that
 * suspender. Same-origin POSTs always carry an Origin header, so a missing
 * one is rejected too.
 */
function isSameOrigin(req: IncomingMessage): boolean {
  return req.headers.origin === new URL(config().PUBLIC_URL).origin;
}

/** A small urlencoded form — anything over 32 KiB is not one of our forms. */
function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024) {
        reject(new Error("form body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))
    );
    req.on("error", reject);
  });
}

/**
 * Slack-markdown reason strings (from domain/settings.ts) carry backticks
 * that mean nothing in a URL-borne flash message — dropped, and the result
 * bounded because it rides in a redirect's query string.
 */
function asFlashText(reason: string): string {
  const plain = reason.replaceAll("`", "");
  return plain.length > 400 ? `${plain.slice(0, 400)}…` : plain;
}

function flashFromQuery(url: URL): Flash | undefined {
  const ok = url.searchParams.get("ok");
  if (ok) return { kind: "ok", text: ok.slice(0, 500) };
  const err = url.searchParams.get("err");
  if (err) return { kind: "err", text: err.slice(0, 500) };
  return undefined;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", config().PUBLIC_URL);
}

/* ---------------------------------------------------------------- handlers */

function handleLanding(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(landingPage());
}

async function handleConfigPage(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const authed = await requireAdmin(req, res);
  if (!authed) return;

  const stored = new Map(listSettings().map((r) => [r.key, r.value]));
  const settings: SettingView[] = await Promise.all(
    SETTINGS.map(async (s) => {
      const value = stored.get(s.key);
      const view: SettingView = {
        key: s.key,
        summary: s.summary,
        expects: s.expects,
        value,
      };
      if (value && s.resolveAs) {
        const resolution = await resolveName(authed.client, s.resolveAs, value);
        view.display = formatResolvedValue(value, s.resolveAs, resolution);
      }
      return view;
    })
  );
  sendHtml(
    res,
    200,
    configPage({
      settings,
      signedInAs: authed.session.name,
      flash: flashFromQuery(requestUrl(req)),
    })
  );
}

async function handleConfigSet(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!isSameOrigin(req)) {
    sendHtml(res, 403, errorPage("Cross-origin request refused."));
    return;
  }
  const authed = await requireAdmin(req, res);
  if (!authed) return;
  const form = await readForm(req);
  const outcome = await applySettingInput(
    authed.client,
    form.get("key") ?? "",
    form.get("value") ?? "",
    authed.session.userId
  );
  if (!outcome.ok) {
    redirect(
      res,
      `/config?err=${encodeURIComponent(asFlashText(outcome.reason))}`
    );
    return;
  }
  const detail = outcome.groupHandle
    ? `the group @${outcome.groupHandle} (${outcome.storedValue})`
    : outcome.storedValue;
  redirect(
    res,
    `/config?ok=${encodeURIComponent(`Set ${outcome.key} to ${detail}.`)}`
  );
}

async function handleConfigUnset(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!isSameOrigin(req)) {
    sendHtml(res, 403, errorPage("Cross-origin request refused."));
    return;
  }
  const authed = await requireAdmin(req, res);
  if (!authed) return;
  const form = await readForm(req);
  const outcome = applySettingUnset(form.get("key") ?? "");
  if (!outcome.ok) {
    redirect(
      res,
      `/config?err=${encodeURIComponent(asFlashText(outcome.reason))}`
    );
    return;
  }
  const text = outcome.removed
    ? `Unset ${outcome.key}.`
    : `${outcome.key} was already unset.`;
  redirect(res, `/config?ok=${encodeURIComponent(text)}`);
}

function handleSignIn(_req: IncomingMessage, res: ServerResponse): void {
  const cfg = config();
  const state = randomBytes(16).toString("base64url");
  const stateToken = signState(
    state,
    Date.now() + STATE_TTL_MS,
    cfg.SLACK_STATE_SECRET
  );

  const authorize = new URL("https://slack.com/openid/connect/authorize");
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", OIDC_SCOPES);
  authorize.searchParams.set("client_id", cfg.SLACK_CLIENT_ID);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set(
    "redirect_uri",
    `${cfg.PUBLIC_URL}/auth/slack/callback`
  );
  // Skips Slack's workspace picker when we already know the one workspace
  // this app serves.
  const installed = installedWorkspace();
  if (installed) authorize.searchParams.set("team", installed.teamId);

  redirect(res, authorize.toString(), [
    serializeCookie(STATE_COOKIE, stateToken, {
      maxAgeSeconds: STATE_TTL_MS / 1000,
      secure: isSecure(),
      path: "/auth",
    }),
  ]);
}

async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const cfg = config();
  const url = requestUrl(req);
  const clearState = serializeCookie(STATE_COOKIE, "", {
    maxAgeSeconds: 0,
    secure: isSecure(),
    path: "/auth",
  });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stateToken = parseCookies(req.headers.cookie).get(STATE_COOKIE);
  const expectedState = stateToken
    ? verifyState(stateToken, cfg.SLACK_STATE_SECRET, Date.now())
    : undefined;
  if (!code || !state || !expectedState || state !== expectedState) {
    res.setHeader("set-cookie", clearState);
    sendHtml(
      res,
      400,
      errorPage(
        "Sign-in didn't complete — the browser's sign-in attempt expired or didn't match. Start again from the configuration page."
      )
    );
    return;
  }

  // The OIDC token is used for exactly one userInfo call, right here, and
  // then dropped. Nothing about it is stored or logged (rule 2).
  const exchange = await new WebClient().openid.connect.token({
    client_id: cfg.SLACK_CLIENT_ID,
    client_secret: cfg.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: `${cfg.PUBLIC_URL}/auth/slack/callback`,
  });
  const identity = (await new WebClient(
    exchange.access_token
  ).openid.connect.userInfo()) as {
    ok?: boolean;
    name?: string;
    "https://slack.com/user_id"?: string;
    "https://slack.com/team_id"?: string;
  };
  const userId = identity["https://slack.com/user_id"];
  const teamId = identity["https://slack.com/team_id"];
  if (!identity.ok || !userId || !teamId) {
    res.setHeader("set-cookie", clearState);
    sendHtml(res, 502, errorPage("Slack didn't say who you are. Try again."));
    return;
  }

  const session: WebSession = {
    userId,
    teamId,
    name: identity.name ?? userId,
    exp: Date.now() + SESSION_TTL_MS,
  };
  log.info("web sign-in", { userId, teamId });
  redirect(res, "/config", [
    clearState,
    serializeCookie(
      SESSION_COOKIE,
      signSession(session, cfg.SLACK_STATE_SECRET),
      { maxAgeSeconds: SESSION_TTL_MS / 1000, secure: isSecure() }
    ),
  ]);
}

function handleSignOut(req: IncomingMessage, res: ServerResponse): void {
  if (!isSameOrigin(req)) {
    sendHtml(res, 403, errorPage("Cross-origin request refused."));
    return;
  }
  redirect(res, "/", [
    serializeCookie(SESSION_COOKIE, "", {
      maxAgeSeconds: 0,
      secure: isSecure(),
    }),
  ]);
}

/* ----------------------------------------------------------------- routes */

type Handler = (
  req: IncomingMessage,
  res: ServerResponse
) => void | Promise<void>;

/**
 * Bolt swallows a rejected handler promise; without this, a Slack API error
 * during sign-in would leave the browser hanging on a request that never
 * finishes.
 */
function guarded(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      log.error("web route failed", {
        path: req.url?.split("?")[0],
        error: String(error),
      });
      if (!res.headersSent) {
        sendHtml(
          res,
          500,
          errorPage("Something went wrong on our side. Try again.")
        );
      } else {
        res.end();
      }
    }
  };
}

export function webRoutes(): CustomRoute[] {
  return [
    { path: "/", method: ["GET"], handler: guarded(handleLanding) },
    { path: "/config", method: ["GET"], handler: guarded(handleConfigPage) },
    {
      path: "/config/set",
      method: ["POST"],
      handler: guarded(handleConfigSet),
    },
    {
      path: "/config/unset",
      method: ["POST"],
      handler: guarded(handleConfigUnset),
    },
    { path: "/auth/slack", method: ["GET"], handler: guarded(handleSignIn) },
    {
      path: "/auth/slack/callback",
      method: ["GET"],
      handler: guarded(handleOAuthCallback),
    },
    {
      path: "/auth/sign-out",
      method: ["POST"],
      handler: guarded(handleSignOut),
    },
  ];
}

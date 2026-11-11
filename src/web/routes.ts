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
  wrongWorkspacePage,
  type Flash,
  type SettingView,
} from "./pages.js";
import { readSuiteHeaders } from "./suiteSession.js";

/**
 * The web surface behind `bot.<domain>`: a landing page, and a configuration
 * page for the same workspace settings as `/hawkbot config`.
 *
 * Who is asking comes from hawk_suite's sign-in gateway and nothing else:
 * Caddy verifies the suite session and passes the Slack identity in trusted
 * headers (web/suiteSession.ts). Hawk Bot runs no sign-in of its own and sets
 * no cookies. What a signed-in person may *do* is then decided by the same
 * HawkBot Admin check every admin command goes through (slack/authz.ts).
 * Without the gateway the page only points at `/hawkbot config`. See ADR-0017.
 *
 * CSRF: the suite cookie is SameSite=Lax, and every state-changing POST also
 * requires an Origin header matching PUBLIC_URL.
 */

type Caller = { userId: string; teamId: string; name: string };

function sendHtml(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
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

/** Whether hawk-bot runs behind hawk_suite's sign-in gateway. */
function suiteGateway(): { issuer: string; teamId: string } | undefined {
  const cfg = config();
  return cfg.HAWK_SUITE_TRUST_PROXY
    ? { issuer: cfg.HAWK_SUITE_ISSUER!, teamId: cfg.HAWK_SUITE_TEAM_ID! }
    : undefined;
}

/** Identity supplied by Caddy after suite authentication, not app authority. */
function suiteCaller(
  req: IncomingMessage,
  gateway: { teamId: string }
): Caller | undefined {
  const identity = readSuiteHeaders(
    req.headersDistinct ?? req.headers,
    gateway.teamId
  );
  return identity
    ? {
        userId: identity.userId,
        teamId: identity.teamId,
        name: identity.name ?? identity.userId,
      }
    : undefined;
}

/**
 * The identity-and-authorization gate in front of the configuration page and
 * both of its POSTs. Writes the appropriate page and returns undefined when
 * the caller should stop. The gateway's team must also be the installed team:
 * a sign-in to some other Slack workspace proves nothing here, and that page
 * is terminal, because a "sign in again" link would loop back to the gateway
 * that just admitted them.
 */
async function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse
): Promise<{ caller: Caller; signOut: string; client: WebClient } | undefined> {
  const gateway = suiteGateway();
  const caller = gateway ? suiteCaller(req, gateway) : undefined;
  if (!gateway || !caller) {
    sendHtml(
      res,
      200,
      signInPage(gateway && new URL("auth/", gateway.issuer).href)
    );
    return undefined;
  }
  const signOut = new URL("auth/logout", gateway.issuer).href;
  const installed = installedWorkspace();
  if (!installed) {
    sendHtml(res, 200, notInstalledPage());
    return undefined;
  }
  if (caller.teamId !== installed.teamId) {
    sendHtml(res, 403, wrongWorkspacePage(caller.name, signOut));
    return undefined;
  }
  if (!(await isHawkBotAdmin(installed.client, caller.userId))) {
    sendHtml(res, 403, forbiddenPage(caller.name, signOut));
    return undefined;
  }
  return { caller, signOut, client: installed.client };
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
      signedInAs: authed.caller.name,
      signOut: authed.signOut,
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
    authed.caller.userId
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

/* ----------------------------------------------------------------- routes */

type Handler = (
  req: IncomingMessage,
  res: ServerResponse
) => void | Promise<void>;

/**
 * Bolt swallows a rejected handler promise; without this, a Slack API error
 * during an admin check would leave the browser hanging on a request that never
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
  ];
}

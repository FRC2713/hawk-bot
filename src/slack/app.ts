import { App } from "@slack/bolt";
import { APP_NAME, BRAND, ICON_SVG, SLASH_COMMAND } from "../brand.js";
import { config } from "../config.js";
import { healthHandler } from "../health.js";
import { log } from "../logger.js";
import { registerCommands } from "./commands.js";
import { registerEvents } from "./events.js";
import { installationStore } from "./installStore.js";

/**
 * Everything Hawk Bot does, it does as itself. There are no user scopes: it
 * never reads a conversation on someone's behalf, and asking for the ability
 * would be a much bigger conversation in a workspace shared with minors.
 *
 * Keep this list and docs/slack-app-manifest.yaml identical — Slack grants
 * what the manifest says, and Bolt only sends people to an authorization
 * screen for what this says.
 */
export const BOT_SCOPES = [
  "commands",
  "chat:write",
  // Posts to a public channel the bot has not been invited to, so an
  // announcement does not require remembering to invite it first.
  "chat:write.public",
  "app_mentions:read",
  // Opens Hawk Bot's own DM with someone, for replies that do not belong in
  // the channel they were asked in.
  "im:write",
  // Resolves whether someone is a workspace Owner or Admin. That is the whole
  // of this app's authorization model; see slack/authz.ts.
  "users:read",
  "team:read",
  "channels:read",
  "groups:read",
];

export function createApp(): App {
  const cfg = config();

  const app = new App({
    signingSecret: cfg.SLACK_SIGNING_SECRET,
    clientId: cfg.SLACK_CLIENT_ID,
    clientSecret: cfg.SLACK_CLIENT_SECRET,
    stateSecret: cfg.SLACK_STATE_SECRET,
    scopes: BOT_SCOPES,
    installationStore,
    // Bolt owns the HTTP server, so the container's health endpoint has to be
    // registered through it rather than served alongside.
    customRoutes: [
      { path: "/health", method: ["GET"], handler: healthHandler },
    ],
    redirectUri: `${cfg.PUBLIC_URL}/slack/oauth_redirect`,
    installerOptions: {
      redirectUriPath: "/slack/oauth_redirect",
      installPath: "/slack/install",
      directInstall: true,
      callbackOptions: {
        success: (_installation, _options, _req, res) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><meta charset="utf-8">
             <meta name="viewport" content="width=device-width,initial-scale=1">
             <title>${APP_NAME}</title>
             <div style="font:16px/1.6 system-ui,sans-serif;color:#1f2023;max-width:34rem;margin:4rem auto;padding:0 1.25rem">
               ${ICON_SVG}
               <h1 style="font-size:1.6rem;margin:1.25rem 0 .25rem">Installed.</h1>
               <p style="margin:0 0 1.5rem;color:${BRAND.red};font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:.8rem">${APP_NAME}</p>
               <p>Head back to Slack and type <code>${SLASH_COMMAND} help</code>
               to see what it can do. Hawk Bot's App Home lists the same thing.</p>
               <p>It acts only as itself and only where it is invited — it holds
               no permission to read anyone's messages on their behalf.</p>
             </div>`
          );
        },
        failure: (error, _options, _req, res) => {
          log.error("oauth failure", { error: String(error) });
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("Authorization failed. Tell a coach.");
        },
      },
    },
  });

  registerCommands(app);
  registerEvents(app);

  app.error(async (error) => {
    log.error("bolt error", { error: String(error) });
  });

  return app;
}

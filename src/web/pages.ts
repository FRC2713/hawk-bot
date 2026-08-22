import { APP_NAME, BRAND, ICON_SVG, SLASH_COMMAND } from "../brand.js";

/**
 * Every page the web surface renders, as pure functions from data to HTML —
 * sibling in spirit to the post-install page in slack/app.ts, and styled to
 * match it. No Slack client, no database, no config: web/routes.ts gathers
 * the data, this turns it into markup, and a test can call any of these
 * without an environment.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 16px/1.6 system-ui, sans-serif; color: #1f2023; margin: 0;
         background: ${BRAND.cream}; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem 4rem; }
  h1 { font-size: 1.6rem; margin: 1.25rem 0 .25rem; }
  .kicker { margin: 0 0 1.5rem; color: ${BRAND.red}; font-weight: 600;
            letter-spacing: .04em; text-transform: uppercase; font-size: .8rem; }
  a { color: ${BRAND.red}; }
  code { background: #fff; border: 1px solid #e5ddd0; border-radius: 4px;
         padding: .1rem .35rem; font-size: .9em; }
  .card { background: #fff; border: 1px solid #e5ddd0; border-radius: 10px;
          padding: 1rem 1.25rem; margin: 1rem 0; }
  .setting-key { font-weight: 600; font-family: ui-monospace, monospace;
                 font-size: .95rem; }
  .summary { margin: .15rem 0 .5rem; color: #5a5147; font-size: .9rem; }
  .current { margin: 0 0 .6rem; font-size: .9rem; }
  .muted { color: #8a8177; }
  form.inline { display: inline; }
  input[type=text] { font: inherit; padding: .35rem .5rem; border: 1px solid
                     #c9beac; border-radius: 6px; width: 100%; max-width: 26rem;
                     box-sizing: border-box; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  button { font: inherit; font-weight: 600; padding: .4rem .9rem; border: 0;
           border-radius: 6px; background: ${BRAND.red}; color: #fff;
           cursor: pointer; }
  button.subtle { background: transparent; color: #5a5147; border: 1px solid
                  #c9beac; font-weight: 400; }
  .flash { border-radius: 8px; padding: .6rem 1rem; margin: 1rem 0; }
  .flash.ok { background: #e8f3e8; border: 1px solid #b9d8b9; }
  .flash.err { background: #f8e9ec; border: 1px solid ${BRAND.red}; }
  .signin { display: inline-block; background: #fff; border: 1px solid #c9beac;
            border-radius: 8px; padding: .6rem 1.1rem; font-weight: 600;
            color: #1f2023; text-decoration: none; }
  .topbar { display: flex; justify-content: space-between; align-items: baseline;
            gap: 1rem; flex-wrap: wrap; }
</style>
<main>
${body}
</main>
</html>`;
}

function header(heading: string): string {
  return `${ICON_SVG}
<h1>${escapeHtml(heading)}</h1>
<p class="kicker">${escapeHtml(APP_NAME)}</p>`;
}

/** `bot.<domain>`'s front door — for the curious, not a console. */
export function landingPage(): string {
  return layout(
    APP_NAME,
    `${header(APP_NAME)}
<p>${escapeHtml(APP_NAME)} is Red Hawk Robotics' team assistant in Slack. It
posts meeting check-ins and weekly schedules, tracks attendance from
reactions, and answers <code>${escapeHtml(SLASH_COMMAND)} help</code>.</p>
<p>It acts only as itself and only where it is invited — it holds no
permission to read anyone's messages on their behalf.</p>
<p class="row">
  <a class="signin" href="/config">Configuration</a>
  <span class="muted">For HawkBot Admins — sign in with Slack required.</span>
</p>`
  );
}

/** Shown at /config when there is no (valid) session yet. */
export function signInPage(): string {
  return layout(
    `Sign in — ${APP_NAME}`,
    `${header("Configuration")}
<p>Workspace settings live behind Slack sign-in, and changing them is limited
to HawkBot Admins.</p>
<p><a class="signin" href="/auth/slack">Sign in with Slack</a></p>
<p class="muted">Signing in only tells ${escapeHtml(APP_NAME)} who you are.
It grants no access to your messages, and no token is kept.</p>`
  );
}

/** Signed in fine, but not a HawkBot Admin. */
export function forbiddenPage(name: string): string {
  return layout(
    `Not authorized — ${APP_NAME}`,
    `${header("Not authorized")}
<p>You're signed in as <strong>${escapeHtml(name)}</strong>, but changing
workspace settings needs HawkBot Admin: membership in the admin User Group
(or being a workspace Owner). Ask a coach to add you, then reload.</p>
${signOutForm()}`
  );
}

/** Sign-in attempted before any workspace has installed the app. */
export function notInstalledPage(): string {
  return layout(
    `Not installed — ${APP_NAME}`,
    `${header("Not installed yet")}
<p>${escapeHtml(APP_NAME)} hasn't been added to a Slack workspace yet, so
there is nothing to configure. A workspace admin can
<a href="/slack/install">install it</a> first.</p>`
  );
}

export function errorPage(message: string): string {
  return layout(
    `Something went wrong — ${APP_NAME}`,
    `${header("Something went wrong")}
<p>${escapeHtml(message)}</p>
<p><a href="/config">Back to configuration</a></p>`
  );
}

function signOutForm(): string {
  return `<form class="inline" method="post" action="/auth/sign-out">
<button class="subtle" type="submit">Sign out</button>
</form>`;
}

export type SettingView = {
  key: string;
  summary: string;
  expects: string;
  /** The stored value, absent when unset. */
  value?: string;
  /**
   * The stored value with its live-resolved name annotation (see
   * domain/configDisplay.ts), when the setting is a channel or usergroup.
   */
  display?: string;
};

export type Flash = { kind: "ok" | "err"; text: string };

/** The settings editor — one card per declared setting. */
export function configPage(args: {
  settings: readonly SettingView[];
  signedInAs: string;
  flash?: Flash;
}): string {
  const flash = args.flash
    ? `<div class="flash ${args.flash.kind}">${escapeHtml(args.flash.text)}</div>`
    : "";
  const cards = args.settings
    .map((s) => {
      const current = s.value
        ? `<p class="current">Currently <code>${escapeHtml(s.display ?? s.value)}</code></p>`
        : `<p class="current muted">Not set</p>`;
      return `<div class="card">
<div class="setting-key">${escapeHtml(s.key)}</div>
<p class="summary">${escapeHtml(s.summary)}</p>
${current}
<form method="post" action="/config/set">
<input type="hidden" name="key" value="${escapeHtml(s.key)}">
<div class="row">
<input type="text" name="value" value="${escapeHtml(s.value ?? "")}"
       placeholder="${escapeHtml(s.expects)}" aria-label="Value for ${escapeHtml(s.key)}">
<button type="submit">Save</button>
</div>
</form>
${
  s.value
    ? `<form class="inline" method="post" action="/config/unset">
<input type="hidden" name="key" value="${escapeHtml(s.key)}">
<button class="subtle" type="submit">Unset</button>
</form>`
    : ""
}
</div>`;
    })
    .join("\n");
  return layout(
    `Configuration — ${APP_NAME}`,
    `${header("Configuration")}
<div class="topbar">
<p class="muted">Signed in as <strong>${escapeHtml(args.signedInAs)}</strong></p>
${signOutForm()}
</div>
${flash}
<p>The same settings as <code>${escapeHtml(SLASH_COMMAND)} config</code>, with
the same validation. Changes take effect immediately.</p>
${cards}`
  );
}

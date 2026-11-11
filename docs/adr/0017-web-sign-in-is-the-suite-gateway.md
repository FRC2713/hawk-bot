# Web sign-in is hawk_suite's gateway; Hawk Bot's own Sign in with Slack is removed

Supersedes ADR-0015.

hawk_suite now runs a sign-in gateway in front of every Hawk app. It signs people in with Slack once, for the whole domain, and Caddy passes the verified Slack team and user to Hawk Bot in trusted headers (`web/suiteSession.ts`). Every browser path on `bot.<domain>` except `/health`, `/slack/events` and the install callback is already behind it, so Hawk Bot's own OpenID Connect flow was a second door to the same room that production never needed.

So the configuration page takes its identity from the gateway and nothing else. Removed: the `/auth/slack`, `/auth/slack/callback` and `/auth/sign-out` routes, the signed session and state cookies (`web/session.ts`), the `openid`/`profile` user scopes and the callback redirect URL in the manifest. Hawk Bot now asks Slack for no user scopes of any kind, which restores rule 1 without ADR-0015's exception. Sign-out is the suite's logout, which was already the only one that worked for a gateway session.

What stays: the HawkBot Admin check (ADR-0004) on every GET and POST, the installed-workspace check, and the Origin check on writes. The gateway admits any workspace member, so it decides who someone is and never what they may do.

Without the gateway (`HAWK_SUITE_TRUST_PROXY` unset), the web page has no sign-in and points at `/hawkbot config`, which edits the same settings. hawk_suite treats the gateway as required, so this only affects local development.

Install OAuth (`/slack/install`, `/slack/oauth_redirect`) is unchanged: the gateway proves identity, but the bot token has to be granted to Hawk Bot's own Slack app.

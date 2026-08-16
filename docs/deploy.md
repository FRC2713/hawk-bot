# Deploying hawk-bot

The team's deployment is [hawk_suite](https://github.com/FRC2713/hawk_suite).
It runs `ghcr.io/frc2713/hawk-bot` behind Caddy at `https://bot.<domain>`,
alongside hawk-shop and hawk-mod, and nobody SSHes into the host to ship. If
you are deploying for Red Hawk Robotics, stop here and read that repo's
`docs/continuous-deployment.md`.

This page is for everything else: running it on a laptop, or on some other
host.

## What Slack requires

Slack delivers slash commands, events, and the OAuth redirect **from its own
servers, over HTTPS**, to `PUBLIC_URL`. So:

- `PUBLIC_URL` must be publicly resolvable.
- It must serve a real certificate. Self-signed will not do.
- It must match the app manifest character for character. A trailing slash or
  an `http://` is a silent failure — Slack simply stops delivering, and the
  symptom is a slash command that times out with no log line here at all.

## 1. The Slack app

Create it from [`slack-app-manifest.yaml`](slack-app-manifest.yaml) at
<https://api.slack.com/apps> → _Create New App_ → _From an app manifest_,
replacing `hawk-bot.example.org` throughout.

This is a **separate app** from Hawk Mod even in the same workspace. Two apps,
two sets of credentials, two databases. Do not merge the manifests.

Copy the Signing Secret, Client ID, and Client Secret from _Basic Information_.

## 2. The environment

```sh
cp .env.example .env
```

Fill in the three credentials above, then generate the two secrets:

```sh
openssl rand -hex 32      # SLACK_STATE_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
```

`TOKEN_ENCRYPTION_KEY` encrypts the stored workspace installation, which
carries the bot token. Losing it costs one reinstall by an admin — keep a copy
anyway, so that reinstall happens when you choose it rather than when a deploy
surprises you.

## 3. The Google service account

Hawk Bot reads the team's calendars as a **service account** — a Google
identity with no human behind it and no mailbox. It has no access to anything
until a calendar is explicitly shared with it, which is three steps, all of
them easy to do partially:

1. **Create the account and its key.** Google Cloud console → _IAM & Admin →
   Service Accounts → Create_. Then _Keys → Add key → Create new key → JSON_.
   The console offers the private key exactly once, at creation.
2. **Enable the Calendar API in that same project.** _APIs & Services →
   Library → Google Calendar API → Enable_. Creating a service account does
   not enable any API; a project with the API off returns 403 to a perfectly
   valid credential.
3. **Share each calendar with the account's own address.** Open the calendar
   in Google Calendar → _Settings and sharing → Share with specific people or
   groups → Add people_, paste the service account's `client_email` (it looks
   like `hawk-bot@your-project.iam.gserviceaccount.com`), and set the
   permission to **See all event details**. "See only free/busy" hides titles
   and times, which is not enough.

Then encode the key file into the environment:

```sh
base64 -i service-account.json | tr -d '\n'   # GOOGLE_SERVICE_ACCOUNT_KEY_BASE64
```

The base64 step is not decoration: the JSON's `private_key` contains literal
newlines and cannot live on one line of `.env` un-encoded.

Which calendars to read is a workspace setting, not a credential — a HawkBot
Admin sets them from Slack once the bot is installed:

```
/hawkbot config set team_meeting_calendar_id  <id>   # required
/hawkbot config set informational_calendar_id <id>   # optional
/hawkbot config set mentor_calendar_id        <id>   # optional
```

A calendar's id is on the same _Settings and sharing_ page, under _Integrate
calendar_. For a secondary calendar it looks like an address ending in
`@group.calendar.google.com`.

### When the calendars live in a Google Workspace

Sharing with the service account is the simple path, and it works for calendars
on ordinary Google accounts. A **Google Workspace** may refuse it — and refuse
it invisibly. The sharing dialog accepts the service account's address, keeps
displaying the entry at "See all event details" indefinitely, and the API still
returns 404, because a service account in its own Cloud project is _outside_
the Workspace domain. The dialog's own footnote is the only hint: "Your
organization might limit how you can share your calendar outside your
organization." It does not say when it has.

The fix is **domain-wide delegation**: the service account reads calendars _as_
a Workspace user, so it is an insider and no external sharing is involved.
Nothing needs to be shared with the service account at all.

1. Get the service account's numeric client id. `/hawkbot calendar` prints it —
   it is otherwise buried in the base64 credential.
2. A Workspace admin opens Admin console → Security → Access and data control →
   **API controls → Domain-wide delegation → Add new**, pastes that client id,
   and authorizes exactly one scope:
   ```
   https://www.googleapis.com/auth/calendar.readonly
   ```
3. Point the bot at a Workspace account that already sees the calendars — the
   account that owns them is the natural choice:
   ```
   /hawkbot config set google_impersonated_user calendar@yourteam.org
   ```

`/hawkbot calendar` then reports "reading calendars as …" instead of
"authenticating as …", and the question shifts from what the service account
was shared to what that user can see. Unset the setting to go back to reading
as the service account.

Prefer this over loosening the Workspace's external sharing settings: that is
an organization-wide change to every calendar in the domain, made to fix one
integration.

### When it doesn't work

`/hawkbot calendar` is the smoke test. It prints the address it authenticates
as — the one that has to appear in the sharing dialog — then fetches live from
Google for each configured calendar and reports what came back. Sharing,
API-not-enabled, and rejected-credential failures each get a distinct
explanation there, because Google's own wording does not distinguish them:
a calendar that was never shared comes back as a bare `Not Found`, identical
to a calendar id that doesn't exist.

`/hawkbot status` shows the last failure per scheduler step, so a sync that
broke between smoke tests is visible without host log access.

Two ways to test an id without committing to it — neither stores anything, so
the scheduler never sees them:

```
/hawkbot calendar <calendar-id>   # read one calendar, ad hoc
/hawkbot calendar control         # read a calendar Google publishes to everyone
```

`control` is the one that settles an ambiguous failure. If the control fails
too, the account cannot read _any_ calendar and the problem is the credential,
its Cloud project, or a policy on the app — not your calendars or their
sharing. If the control succeeds while yours fail, the opposite: everything
about the credential works and the calendars genuinely are not shared with the
service account's address, whatever the sharing dialog appears to show.

## 4. Run it

```sh
docker compose up -d
docker compose logs -f hawk-bot
```

`docker-compose.yml` in this repo publishes port 3000 on the host, because it
is the standalone path. In hawk_suite the container publishes nothing.

Check it:

```sh
curl -s http://localhost:3000/health
```

`{"status":"ok","installed":false,...}` before the app is installed is the
expected state — running and waiting.

## 5. Install into the workspace

A workspace admin opens `https://<public-url>/slack/install` once, approves the
scopes, and the bot is live. `/hawkbot help` in any channel confirms it.

Reinstalling after a scope change is the same URL. Slack does not grant new
scopes to an existing installation on its own — if a new command comes back
with `missing_scope`, that is what happened.

## Reaching a laptop from Slack

For development, put a tunnel in front of `localhost:3000` and use its HTTPS
hostname as `PUBLIC_URL` in both `.env` and the manifest:

```sh
cloudflared tunnel --url http://localhost:3000
```

The hostname changes every time the tunnel restarts, and every change means
editing the manifest again. Expect that; it is the cost of Slack's model, not a
misconfiguration.

## Upgrading

```sh
docker compose pull && docker compose up -d
```

Migrations are applied on boot. There is no second step and no downtime worth
planning for.

## Backups

One SQLite database in the volume, holding the installation and the settings
table. Nothing in it is irreplaceable — an admin reinstalling and a coach
re-entering a couple of settings recreates it — so this is a convenience
backup, not the obligation hawk-mod's volume is.

Use SQLite's backup API rather than copying the file, which is in WAL mode:

```sh
docker compose exec hawk-bot node -e "const D=require('better-sqlite3');new D(process.env.DATA_DIR+'/hawk-bot.db').backup('/data/backup.db').then(()=>process.exit(0))"
```

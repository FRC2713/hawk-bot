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
<https://api.slack.com/apps> → *Create New App* → *From an app manifest*,
replacing `hawk-bot.example.org` throughout.

This is a **separate app** from Hawk Mod even in the same workspace. Two apps,
two sets of credentials, two databases. Do not merge the manifests.

Copy the Signing Secret, Client ID, and Client Secret from *Basic Information*.

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

## 3. Run it

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

## 4. Install into the workspace

A workspace admin opens `https://<public-url>/slack/install` once, approves the
scopes, and the bot is live. `/hawk help` in any channel confirms it.

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

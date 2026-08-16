# hawk-bot

Hawk Bot is FRC 2713 Red Hawk Robotics' team assistant in Slack: one slash
command, `/hawkbot`, behind which the team's own tooling accumulates.

It is deliberately the _public_ bot of the pair. Its sibling
[hawk-mod](https://github.com/FRC2713/hawk-mod) exists to watch direct messages
for youth protection, and everything about it — user tokens, encrypted message
text, a private findings channel — follows from that. Hawk Bot asks for **no
user tokens at all**. It acts only as itself, only where it is invited, and
everything it does is visible to the people in the room.

Run by [hawk_suite](https://github.com/FRC2713/hawk_suite) at
`https://bot.<domain>`.

## What it does today

| Command           | Who    | What                                             |
| ----------------- | ------ | ------------------------------------------------ |
| `/hawkbot help`   | anyone | Lists every command                              |
| `/hawkbot status` | anyone | Uptime, install state, how much is configured    |
| `/hawkbot whoami` | anyone | Your Slack id, and whether you count as an admin |
| `/hawkbot config` | admins | Show or change workspace settings                |

Plus an App Home tab that renders itself from the same command list, and a
reply when someone @-mentions the bot pointing them at `/hawkbot help`.

That is the floor, not the ceiling. The point of this repo's shape is that
adding the next capability — practice reminders, build-season checklists, an
announcement relay, robot-code CI notifications — is one file in
`src/commands/` and one line in `src/commands/registry.ts`.

## Authorization

There is no roster and no admin list. `adminOnly` commands ask Slack whether
you are a workspace Owner or Admin (`src/slack/authz.ts`).

The workspace already knows who runs the team. A second list here would drift,
and the way it drifts is someone keeping a permission after they have left.

## Adding a command

```ts
// src/commands/roster.ts
import type { Command } from "./types.js";

export const roster: Command = {
  name: "roster",
  summary: "Who is on the team",
  adminOnly: false,
  async run(ctx) {
    return { text: "…" };
  },
};
```

Register it in `src/commands/registry.ts`. `help`, the App Home, and
`/health`'s command count all read that array, so nothing else needs editing —
and `test/registry.test.ts` will fail if the name collides with an existing one.

Replies are ephemeral by default: only the person who typed the command sees
them. Return `visibility: "in_channel"` when the answer belongs to everyone in
the room, and think about whether it does.

## Setup

Hawk Bot needs a Slack app of its own — **not** Hawk Mod's. Create one from
[`docs/slack-app-manifest.yaml`](docs/slack-app-manifest.yaml), replacing
`hawk-bot.example.org` with the public HTTPS origin it will run at.

Then, on the host or a laptop:

```sh
cp .env.example .env      # fill in the four Slack credentials
openssl rand -hex 32      # → SLACK_STATE_SECRET
openssl rand -base64 32   # → TOKEN_ENCRYPTION_KEY
npm ci && npm run dev
```

A workspace admin opens `https://<public-url>/slack/install` once. That stores
the workspace's bot token — encrypted — and the bot is live.

Slack delivers slash commands, events, and the OAuth redirect **from its own
servers over HTTPS**, so `PUBLIC_URL` has to be publicly resolvable with a real
certificate. `localhost` cannot work; [`docs/deploy.md`](docs/deploy.md)
covers the tunnel that makes a laptop reachable.

## Development

```sh
npm run dev          # tsx watch
npm test             # node:test, no Slack or database needed
npm run typecheck
npm run format
npm run build
```

The tests cover the parts with rules in them — command parsing, the settings
registry — and nothing that would need a live Slack workspace to exercise. CI
runs typecheck, format check, tests, and build on every PR.

## State

One SQLite database in `DATA_DIR`, holding the workspace installation and a
small settings table. Migrations in `migrations/` are applied on boot, so an
upgrade is `docker compose pull && up -d` and nothing else.

`TOKEN_ENCRYPTION_KEY` encrypts the stored installation, which carries the bot
token. Losing it costs one reinstall by an admin — it is not the irreplaceable
key that hawk-mod's variable of the same name is.

## Deploying

The team's deployment is [hawk_suite](https://github.com/FRC2713/hawk_suite),
which runs `ghcr.io/frc2713/hawk-bot` behind Caddy at `bot.<domain>`. Merging
here publishes an image; it does not deploy anything. That is the point — see
hawk_suite's `docs/continuous-deployment.md`.

For running it anywhere else, [`docs/deploy.md`](docs/deploy.md).

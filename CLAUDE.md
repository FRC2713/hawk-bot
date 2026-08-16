# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Commands

```sh
npm run dev          # tsx watch src/index.ts
npm test             # node:test via tsx; pure, no Slack and no database
npm run typecheck    # tsc --noEmit
npm run format:check # prettier — CI fails on unformatted files
npm run build        # tsc → dist/
```

CI (`.github/workflows/ci.yml`) runs typecheck, format check, tests, and build.
All four are seconds; run them before pushing. `docker.yml` publishes
`ghcr.io/frc2713/hawk-bot` on every push to `main`.

## What this is

The Red Hawk Robotics team assistant for Slack: one slash command,
`/hawkbot`, with subcommands behind it. Node 22, TypeScript, Bolt, SQLite via
better-sqlite3. One container, one volume.

It is the sibling of [hawk-mod](https://github.com/FRC2713/hawk-mod), and the
difference is the thing to hold onto:

|             | hawk-mod                              | hawk-bot                         |
| ----------- | ------------------------------------- | -------------------------------- |
| Slack app   | its own                               | **a separate one**               |
| User tokens | yes, per adult — the whole point      | **none, ever**                   |
| Reads DMs   | yes, that is the product              | no                               |
| Stores      | consent records, minors' message text | an install token, a few settings |

Both are deployed by [hawk_suite](https://github.com/FRC2713/hawk_suite), which
routes `mod.<domain>` and `bot.<domain>` to them. Deployment questions belong
in that repo; this one only publishes an image.

## Architecture

```
src/index.ts            boot: config → db (migrations) → Bolt → listen
src/config.ts           zod schema over process.env, parsed lazily
src/brand.ts            APP_NAME, SLASH_COMMAND, colors, icon. No config, no env.
src/crypto.ts           AES-256-GCM for the stored installation
src/health.ts           GET /health — touches SQLite so a bad volume shows here
src/commands/           the command surface (see below)
src/domain/settings.ts  which workspace settings exist, and what is a valid value
src/domain/calendarAccess.ts
                        reads the service account key, and turns a refusal from
                        Google into the fix for it. Pure. Its header says why a
                        raw "Not Found" must never reach a mentor.
src/calendar/client.ts  the only Google I/O. Pages events.list to the end —
                        the default page size is 250 and truncates in silence.
src/db/client.ts        opens SQLite, applies migrations/ on boot
src/db/repo.ts          every SQL statement in the app
src/slack/app.ts        Bolt wiring, BOT_SCOPES, OAuth install pages
src/slack/commands.ts   the slash-command router
src/slack/events.ts     app_home_opened, app_mention, app_uninstalled
src/slack/authz.ts      "is this person a workspace admin", cached 5 minutes
src/slack/home.ts       the App Home view, rendered from the command registry
```

### The command registry is the extension point

`src/commands/registry.ts` exports `COMMANDS`. The router resolves against it,
`help` renders it, the App Home lists it, `/health` counts it. Adding a
capability is a file in `src/commands/` plus a line in that array — and
nothing else, deliberately.

`src/commands/parse.ts` is pure and tested: bare `/hawkbot` means `help`,
subcommand names are case-insensitive, `rest` keeps the original casing of the
arguments. Handlers get a parsed `CommandContext` and return a `CommandReply`;
they never touch `ack()` or Slack's response payloads.

Replies default to ephemeral. A command that speaks to the whole channel has to
say so, because the default should be the one that cannot embarrass anyone.

### Authorization comes from Slack

`adminOnly: true` on a command requires the caller to be a HawkBot Admin:
membership in the Slack User Group named by the `admin_usergroup` setting,
with workspace Owners always included too as a bootstrap fallback so an
empty or misconfigured group can't lock everyone out (see ADR-0004 and
CONTEXT.md, HawkBot Admin). Both checks are resolved live against Slack
(`usergroups.users.list` and `users.info`) and cached 5 minutes in
`slack/authz.ts`. There is no roster or allow-list of user ids stored in
this repo's own database — the group membership lives in Slack itself,
which is what keeps it from drifting in the direction of someone keeping
access after they've left.

### Rules live in `domain/`

`domain/settings.ts` decides which settings exist and what a valid value is;
`commands/config.ts` is left with I/O. Anything with a rule in it belongs in
`domain/`, where a test can reach it without Slack or SQLite.

## Container

`Dockerfile` is a four-stage build (deps / proddeps / builder / runner) on
`node:22-bookworm-slim`. Two things there are load-bearing and commented in
place: Debian rather than Alpine for better-sqlite3's glibc prebuilds, and
`npm ci --ignore-scripts` so npm does not rebuild those prebuilds from source.

`migrations/` ships into the image next to `dist/`, because `db/client.ts`
walks up from the module to find it and applies migrations on boot. That is
what makes an upgrade one step for the operator.

Runs as a non-root user, declares a `HEALTHCHECK` against `/health`, publishes
nothing in the suite — Caddy fronts it.

## Rules that are load-bearing

1. **No user scopes.** Ever. This app is in a workspace shared with minors and
   its defensibility rests on being unable to read anything a person could not
   see it read. Adding a user scope changes what this app _is_.
2. **Never log message text or a token.** `logger.ts` writes JSON to stderr and
   that is not an auditable place.
3. **Migrations that have shipped are never edited.** Add another file.
4. **Config is environment, settings are database.** Credentials and hostnames
   in `.env`; workspace preferences in the `settings` table, declared in
   `domain/settings.ts`. Nothing team-specific is ever baked into the image.
5. **Keep `BOT_SCOPES` and `docs/slack-app-manifest.yaml` identical.** Slack
   grants what the manifest says; Bolt asks for what the code says. When they
   disagree the symptom is a command that silently does nothing.
6. **`.env.example` documents every variable `config.ts` reads.** A missing one
   reads as "the feature is off".

## Agent skills

### Issue tracker

GitHub Issues on `frc2713/hawk-bot`, via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root, once they exist.
See `docs/agents/domain.md`.

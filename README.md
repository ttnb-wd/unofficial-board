# The Unofficial Board

The Unofficial Board is a production-first Telegram bot. It implements a
fail-closed private PRELAUNCH mode, the Smart Poll and Group Budget Vote
workflows, and scaffolds for the other confirmed features.

## Requirements

- Node.js 22 or later and npm
- The configured Neon PostgreSQL database
- A Telegram bot token from BotFather
- The numeric ID of the configured Telegram group
- The owner's numeric Telegram user ID

## Configure private PRELAUNCH

Install dependencies and generate Prisma Client:

```powershell
npm ci
npm run db:generate
```

Set these values in the existing `.env` file:

- `TELEGRAM_BOT_TOKEN`: the BotFather token; do not share or log it.
- `TELEGRAM_GROUP_ID`: the configured group's numeric ID.
- `PRELAUNCH_OWNER_TELEGRAM_ID`: your numeric Telegram user ID.
- `ACCESS_MODE=PRELAUNCH`: keep this explicit during private testing. The
  application also defaults to PRELAUNCH if the setting is omitted.
- `DATABASE_URL`: the existing Neon connection URL with TLS enabled.
- `MINI_APP_URL`: the public HTTPS origin serving the embedded form, for
  example `https://forms.example.com`. Leave it unset until hosting is ready.
- `MINI_APP_PORT=3000`: the local port for the Mini App server; configure the
  host or reverse proxy to forward requests to this port.
- `LOG_LEVEL=info`: optional.

The bot does not query or message the configured group in PRELAUNCH. Only the
configured owner can use the private `/start` dashboard; other private users
are denied. Polls and budget votes are saved to the real Neon database and
marked as PRELAUNCH test records. PRELAUNCH access does not create a
group-membership record.

To run the bot and Mini App server locally:

```powershell
npm run dev
```

The Mini App needs a public HTTPS origin for Telegram to open it inside the
private chat. Set `MINI_APP_URL` to that origin and route its requests to the
Mini App server on `MINI_APP_PORT`. In Telegram, send `/start`, choose Smart
Poll or Group Budget Vote, then tap **Create Poll** or **Create Budget Vote**.
The embedded form provides editable question/title and choice fields, with
three initial choices (and exact 10,000, 20,000, and 30,000 MMK defaults for a
budget vote). **Done** saves to the existing Neon database. PRELAUNCH remains
owner-only and does not send anything to the group.

## Database migrations

These form changes introduce no new migration. The database must already
have the repository’s existing migrations, including the exact-MMK and
idempotency tables from `20261122181000_mini_app_exact_budget_amounts` and
the draft states from `20261122190000_native_telegram_forms`. Check the
existing Neon database with `npm run db:migrate:status`. If migrations are
pending, review them and verify Neon recovery coverage before running
`npm run db:migrate` once as a separate release step. Existing range-based
votes and native form records are retained.

## Koyeb HTTPS deployment

After deployment approval:

1. Provide Koyeb with a source repository or source archive containing the
   project, including `public/`, `prisma/`, and the npm lockfile. Keep
   `.env` outside the deployment source.
2. Create one Node.js **Web Service** with the buildpack and Node.js 22 or
   later. Set the custom build command to
   `npm run db:generate && npm run build` and the run command to `npm start`.
3. Expose HTTP port `3000` at route `/` and configure the HTTP health check
   at `/healthz`. Set `PORT=3000` and leave `MINI_APP_PORT` unset or set it
   to the same value. Configure one always-on instance in one region. The
   bot uses Telegram long polling, so stop any other process using the same
   bot token before switching traffic. The existing birthday and countdown
   features are scaffolds and these two forms have no scheduler jobs.
4. Set `ACCESS_MODE=PRELAUNCH`, `PRELAUNCH_OWNER_TELEGRAM_ID`,
   `TELEGRAM_GROUP_ID`, and the existing `TELEGRAM_BOT_TOKEN` and
   `DATABASE_URL` secrets. Set `MINI_APP_URL` to the public HTTPS origin
   shown by Koyeb, such as `https://<app>.koyeb.app`. Run the migration
   status check against that same Neon database and resolve any pending
   migrations before using the forms.
5. Verify HTTPS `/healthz` and both `/mini-app?feature=...` routes. As the
   configured owner, open a fresh dashboard in the bot’s private chat,
   submit one of each form, confirm it closes after showing success, and
   verify the saved entries using **My polls** and **My budget votes**.

Telegram’s inline Mini App launch button is available in private bot chats.
This flow uses the HTTPS URL on each inline button. It needs no separate
BotFather menu button, named Mini App, or chat message containing form data.
The app accepts Telegram’s signed launch data for five minutes, after which
the owner can reopen the form from the bot. See [Telegram Mini Apps](https://core.telegram.org/bots/webapps),
[Koyeb deployment](https://www.koyeb.com/docs/build-and-deploy), and
[Koyeb health checks](https://www.koyeb.com/docs/run-and-scale/health-checks).

## Access lifecycle

- **PRELAUNCH (default):** only the configured owner in a private chat is
  allowed. Group updates are ignored and no group membership lookup is made.
- **LIVE (explicit only):** set `ACCESS_MODE=LIVE` deliberately after approval.
  Private feature access then requires a fresh check of the configured group's
  current membership. No administrator approval is part of feature access.
- Both modes preserve resource ownership checks for future personal-data
  changes and deletion operations.

Never enable LIVE automatically. The bot has not been deployed.

## Embedded private-chat forms

The Create buttons are Telegram Mini App buttons and open the forms inside
Telegram. Smart Poll starts with a question and three answer inputs. Budget
Vote starts with a title and three exact MMK amount inputs. Both forms support
adding/removing choices and save only when **Done** is tapped. After the
server confirms the save, the form shows success and closes back to Telegram. The forms need
`MINI_APP_URL` to be a public HTTPS origin; without it, the Create button
explains that setup is required rather than opening a native-message workflow.

`/poll` and `/budget` also provide an embedded-form launch button.
`/polls` and `/budgets` list saved items. Existing draft records are preserved;
opening either embedded form does not cancel or alter drafts.

- `/cancel`: cancel your unfinished poll and budget drafts. Published polls
  and votes are not changed.

No PRELAUNCH operation sends a message to the configured group or creates a
group-membership record.

## Other confirmed features

1. Birthday Reminder
2. Shared Memory Vault
3. Plan Countdown
4. One Tap Hangout
5. Bill Splitter

These remain scaffolds. Memory Vault is intended to let every current group
member create albums, upload photos, view albums, and share memories without
approval once its workflows are built.

## Validation

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

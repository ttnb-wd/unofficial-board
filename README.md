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
- `MINI_APP_URL`: the HTTPS tunnel origin for local Telegram testing. Leave
  it unset for same-origin HTTP development on loopback.
- `SERVE_MINI_APP=true`: the default, which serves the forms locally.
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

## Render and Vercel deployment

Render runs the Telegraf bot and API. Vercel serves the static Mini App. The
API continues to use the existing Neon database. Migrations run separately.

| Setting | Render Free Web Service | Vercel Hobby |
| --- | --- | --- |
| Source | Repository root, `render.yaml` | Repository root, `vercel.json` |
| Runtime or preset | Node.js 22 | Other, Node.js 22 for builds |
| Install and build | `npm ci --include=dev && npm run db:generate && npm run build` | Skip install, then `npm run build:vercel` |
| Start | `npm start` | Static output in `dist-vercel` |
| Health or form route | `GET /healthz` | `/mini-app?feature=poll` and `/mini-app?feature=budget` |

**Render variables**

- Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `PRELAUNCH_OWNER_TELEGRAM_ID`,
  and `DATABASE_URL` to the existing values.
- The Blueprint sets `ACCESS_MODE=PRELAUNCH`, `SERVE_MINI_APP=false`, and
  `NODE_VERSION=22.x`. Leave `MINI_APP_PORT` unset so the server uses Render's
  `PORT`. `LOG_LEVEL` defaults to `info`.
- Set `MINI_APP_URL` to the canonical Vercel production HTTPS origin,
  without a path. Render uses it for both Create buttons and the API's
  exact-origin CORS allowlist.

**Vercel variable**

- Set `MINI_APP_API_ORIGIN` for **Production** to the Render HTTPS origin,
  without a path. The build writes it into public `config.js`. Telegram
  and database credentials belong in Render.

**Approved rollout**

1. Publish the approved commit to the GitHub branch selected for deployment.
   Confirm the existing Neon migration status from a trusted shell with
   `npm run db:migrate:status`. Handle any pending existing migrations as
   a separate approved database step before using the forms.
2. Create a Render Blueprint from `render.yaml`, or configure the existing
   Free Web Service with the settings above. Set `MINI_APP_URL` to the planned
   Vercel production origin. Stop any other poller using this bot token
   before starting Render. Confirm that the token is ready for polling,
   since Telegraf clears any prior webhook when it starts polling. Check
   that Render's HTTPS `/healthz` returns `{"status":"ok"}`.
3. Import the same repository into Vercel Hobby. Use the repository root,
   the **Other** preset, and Node.js 22. Set `MINI_APP_API_ORIGIN` to the
   Render origin and deploy to Production. Copy the stable Vercel production
   origin. If it differs from the planned value, update `MINI_APP_URL` on
   Render and redeploy Render before opening the forms.
4. Check that a POST preflight to either Render API endpoint from the Vercel
   origin returns 204 with a matching `Access-Control-Allow-Origin`.
   Confirm a preview origin is rejected. In the owner's private Telegram
   chat, open a fresh `/start` dashboard, submit both forms, and verify the
   records under **My polls** and **My budget votes**.

**Render Free behavior**

Render Free sleeps after 15 minutes without inbound traffic. Outbound
Telegram polling cannot wake it. If the bot sleeps and does not answer
`/start`, open the Render HTTPS `/healthz` URL and retry in Telegram after
it responds. The Vercel form waits for API health before sending a save.
An interrupted save can be retried with the same submission ID while the
form remains open. If the Telegram session has expired, check saved items
before reopening to retry. [Render Free](https://render.com/docs/free)

Telegram inline Mini App buttons launch from a private bot chat. This
flow needs no separate BotFather menu button or named Mini App. Signed
Telegram launch data expires after five minutes.
[Telegram Mini Apps](https://core.telegram.org/bots/webapps)

## Access lifecycle

- **PRELAUNCH (default):** only the configured owner in a private chat is
  allowed. Group updates are ignored and no group membership lookup is made.
- **LIVE (explicit only):** set `ACCESS_MODE=LIVE` deliberately after approval.
  Private feature access then requires a fresh check of the configured group's
  current membership. No administrator approval is part of feature access.
- Both modes preserve resource ownership checks for future personal-data
  changes and deletion operations.

Never enable LIVE automatically.

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

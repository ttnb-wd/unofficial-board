# The Unofficial Board

The Unofficial Board is a production-first Telegram bot. It implements a
fail-closed private PRELAUNCH mode, the Smart Poll and Group Budget Vote
workflows, Bill Splitter, Birthday Reminder, Plan Countdown, and One Tap Hangout.

## Requirements

- Node.js 22 or later and npm
- The configured Neon PostgreSQL database
- A Telegram bot token from BotFather
- The numeric ID of the configured Telegram group
- The owner's numeric Telegram user ID

## Test on Render and Vercel

Follow the [Render test group runbook](docs/RENDER-TEST-GROUP.md) for the
existing bot, hosted Mini App, and Neon database. Set `ACCESS_MODE=PRELAUNCH`.
With `TEST_GROUP_ENABLED=false`, only the owner can use PRELAUNCH and the
bot has no group workflows. Enable the test flag after applying the additive
migration and verifying the dedicated group.

For automated checks, install dependencies with `npm ci` and generate the
Prisma Client with `npm run db:generate`. Use disposable PostgreSQL and
mocked Telegram for integration tests.

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

Apply pending migrations as a separate release step, then follow the
[Render test group runbook](docs/RENDER-TEST-GROUP.md) for deployment,
disablement, and Telegram acceptance.

**Render Free behavior**

Render Free sleeps after 15 minutes without inbound traffic. Outbound
Telegram polling cannot wake it. If the bot sleeps and does not answer
`/start`, open the Render HTTPS `/healthz` URL and retry in Telegram after
it responds. The Vercel form waits for API health before sending a save.
An interrupted save can be retried with the same submission ID while the
form remains open. If the Telegram session has expired, check saved items
before reopening to retry. Birthday and countdown workers do not run during
sleep. On wake, they resume from PostgreSQL. A countdown reminder or birthday
wish can arrive late or expire outside its delivery window. Bill announcements,
hangout invitations and group message edits also wait for the process to wake.
[Render Free](https://render.com/docs/free)

Telegram inline Mini App buttons launch from a private bot chat. The shared
Mini App dashboard opens at `/mini-app`. To activate the optional chat menu
button after deployment, use BotFather’s `/setmenubutton`, set the label to
**The Board**, and enter `https://<MINI_APP_URL host>/mini-app`.
`buildBoardMenuButton` prepares the same payload for the Bot API. The bot
leaves the menu button setting to the operator. Set the Main Mini App in
BotFather to `https://unofficial-board-lyart.vercel.app/mini-app`. Both buttons
open Home. Feature links keep their own destinations. The API verifies signed
identity, including launches without a query ID. Signed launch data expires
after five minutes. Reopen The Board in Telegram when it expires.
[Telegram Mini Apps](https://core.telegram.org/bots/webapps)

In an authorized private chat, `/start` and `/menu` send the inline shortcuts
and install the native reply keyboard. Telegram is asked to resize the keyboard
and hide it after a selection. The keyboard icon should make it available again.
Reply-keyboard Web Apps receive empty `initData`, so the reply options send a
message to the bot and return an authenticated inline shortcut to the feature.
The inline menu itself opens feature homes in one tap.

Before rollout, check this on a real iPhone using the existing bot
in the owner's private chat. Run both commands, switch to normal typing, and
reopen options with the keyboard icon. Select each option, check that it hides
the options and returns the matching inline shortcut, then open that shortcut.
Check that the blue **The Board** button still opens the full dashboard.
[Reply keyboard behavior](https://core.telegram.org/bots/api#replykeyboardmarkup)
[Telegram launch data](https://core.telegram.org/bots/webapps#webappinitdata)

## Access lifecycle

- **PRELAUNCH (default):** only the configured owner in a private chat is
  allowed. Group updates are ignored and no group membership lookup is made.
- **LIVE (explicit only):** set `ACCESS_MODE=LIVE` deliberately after approval.
  Private feature access then requires a fresh check of the configured group's
  current membership. Telegram guarantees that lookup for other users when
  the bot is a group administrator. Members need no individual approval.
- Both modes preserve resource ownership checks for future personal-data
  changes and deletion operations.

Never enable LIVE automatically.

## Embedded private-chat forms

The Create buttons are Telegram Mini App buttons and open the forms inside
Telegram. Smart Poll starts with a question and two answer inputs. Budget
Vote starts with a title and three exact MMK amount inputs. Both forms support
adding/removing choices. After a successful save, forms launched from a
bot button close back to Telegram. Forms launched from The Board show the
confirmation and let users return to their previous dashboard tab. The forms need
`MINI_APP_URL` to be a public HTTPS origin; the feature menu displays setup guidance until that origin is configured.

`/poll` and `/budget` also provide an embedded-form launch button.

Use **Activity → Voting and results** in The Board to open group ballots.
Custom poll and budget ballots use the same saved selections and results as
the Telegram bot. Older Telegram-native ballots offer a handoff to the bot.
In PRELAUNCH, the owner can simulate a ballot using saved preview records.
`/polls` and `/budgets` list saved items. Existing draft records are preserved;
opening either embedded form does not cancel or alter drafts.

- `/cancel`: cancel your unfinished poll and budget drafts. Published polls
  and votes are not changed.

No PRELAUNCH operation sends a message to the configured group or creates a
group-membership record.

## Poll and budget voting

- **Creator** — Open the feature in the private chat, tap **Create**, and
  submit with **Done**. Open **My polls** or **My budget votes** and select
  the item to see its status, choices, and **Results**. In LIVE, a saved
  LIVE draft can be published explicitly and its creator can close voting.
- **Group Publishing Preview** shows the announcement privately in PRELAUNCH.
- **Member View Preview** — In PRELAUNCH, the owner can choose a saved item
  from **Member View Preview** or open the preview from its detail. Select
  an option and tap **Submit vote** to see simulated results. The preview
  starts from zero and uses no saved ballots, group messages, or extra records.
- **LIVE member** — Vote in the group for a single-answer poll or budget vote.
  For a multi-answer poll, open **Choose answers privately**. **View ballot**
  and **Published votes** open the private ballot and results. Current group
  members can select and submit an answer or exact MMK amount. A new submission
  replaces the member's previous selection. Closed votes remain available for
  results. Multi-answer polls calculate each option's percentage against the
  number of unique voters, so percentages can exceed 100% when added together.

The Board refreshes Home while visible and can refresh an open ballot on
request. Failed Home refreshes clear the old snapshot and offer a retry.
Older Telegram-native polls still use the original group message for voting.
Historical anonymous native option counts are available on the original poll.
Existing budget range ballots keep their saved selections across interfaces.
PRELAUNCH data cannot be published after switching to LIVE.

Group ballot results and bill share statuses are edited in place using the
stored message IDs. PostgreSQL records pending edits in the same transaction
as the underlying changes. The running backend checks for pending edits
every 15 seconds. Transient edit failures are retried against the same
message. A deleted or inaccessible message is never replaced automatically.
Payment verification alerts go only to the receiver's private bot chat.
Group bill messages contain share amounts and statuses only. Payment
screenshots are available through actor-checked endpoints to the debtor and
receiver.

An uncertain poll or budget publication stays in `PUBLISHING` for operator
reconciliation. A definite Telegram rejection permits the creator to retry.
The other durable delivery flows hold uncertain sends for reconciliation as
`UNKNOWN`. Telegram delivery cannot be guaranteed exactly once. Before
deploying this revision, apply the additive group message refresh migration
and regenerate Prisma Client. Test the live launch contexts and group permissions
in an isolated Telegram test group before enabling LIVE for the actual group.

If an announcement's delivery is uncertain, the record stays in **Publication
pending** to avoid retrying a send that Telegram may already have accepted.
An operator must reconcile the group message and database status before retry.

## Bill Splitter

Create bills and review debts from the private bot menu. See the
[Bill Splitter rollout, migration, and privacy guide](docs/BILL-SPLITTER.md).

## Birthday Reminder

Save or remove your birthday from the private bot menu and see upcoming group
birthdays. See the [Birthday Reminder guide](docs/BIRTHDAY-REMINDER.md) for
PRELAUNCH previews, migration, and delivery recovery.

## Validation

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

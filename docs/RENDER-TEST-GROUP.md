# Render test group runbook

Run Telegram acceptance on the existing Render service, Vercel Mini App, and
Neon database. Test mode is opt-in and runs with `ACCESS_MODE=PRELAUNCH`.
The existing production group and bot identity stay configured.

## Render configuration

| Variable | Value |
| --- | --- |
| `ACCESS_MODE` | `PRELAUNCH` |
| `TEST_GROUP_ENABLED` | `false` for the initial deploy, then `true` for acceptance |
| `TEST_GROUP_ID` | `-5351770956` |
| `TELEGRAM_GROUP_ID` | `-5305465370` |
| `PRELAUNCH_OWNER_TELEGRAM_ID` | `7628120179` |
| `TELEGRAM_BOT_TOKEN` | Existing secret for `@unofficial_board_bot` |
| `DATABASE_URL` | Existing Neon runtime URL, including its TLS options |
| `MINI_APP_URL` | `https://unofficial-board-lyart.vercel.app` |
| `SERVE_MINI_APP` | `false` |
| `NODE_VERSION` | `22.x` |
| `LOG_LEVEL` | `info` |
| `MINI_APP_PORT` | Unset. Render supplies `PORT`. |

Keep Telegraf's verbose `DEBUG` logging unset. Use the HTTPS origin alone
for `MINI_APP_URL`. The backend appends `/mini-app` and feature paths and uses
the same origin for API CORS. The Main Mini App and blue **The Board** menu
button continue to open the existing Vercel URL with `/mini-app`.

- Build command is `npm ci --include=dev && npm run db:generate && npm run build`.
- Start command is `npm start`.
- Health check path is `/healthz`.
- In the existing Vercel project, set Production `MINI_APP_API_ORIGIN` to
  `https://unofficial-board.onrender.com`. Build with `npm run build:vercel`
  and publish `dist-vercel`, as specified in `vercel.json`. The frontend has no
  scope flag. The signed requests use the scope active on Render.

## Migration and manual deploy

1. Verify that the test group has the expected numeric ID and that
   `@unofficial_board_bot` is an administrator there. Telegram guarantees
   membership lookups for other users when the bot is an administrator.
   If Telegram migrated the group to a supergroup, use its verified current ID
   and keep any existing records under their original scope.
   [Telegram Bot API getChatMember](https://core.telegram.org/bots/api#getchatmember)
2. From the reviewed release checkout, set `DATABASE_URL` in the migration
   shell to the **direct** connection for the existing Neon database. Resolve
   any migration-history errors before continuing. The local release rehearsal
   uses disposable PostgreSQL.

   ```powershell
   npm ci --include=dev
   npm run db:migrate:status
   npm run db:migrate
   npm run db:migrate:status
   ```

   The first status command can report pending migrations with a nonzero exit.
   `20261124100000_render_test_group` adds `TelegramGroup.testOnly` and
   `GroupMembership.testAuthorized`, both defaulting to false. The migration
   is required before starting the new backend, including with test mode off.
   Existing ownership and delivery history are retained.
3. Deploy the reviewed commit to the existing Render service with the flag
   off. Deploy the reviewed frontend to the existing Vercel project. Open
   `https://unofficial-board.onrender.com/healthz` and expect HTTP 200. The
   startup log should show `mode=PRELAUNCH` and `testGroupEnabled=false`.
   Ensure only one bot process is polling this Telegram token.
4. Set the flag to `true` in Render and restart or redeploy the service with
   the remaining settings above. Wait for health to return 200 and the
   startup log to show `testGroupEnabled=true`. In the test group, the owner
   sends `/test_group@unofficial_board_bot` and confirms the expected ID and
   PRELAUNCH mode. The first test startup reserves a new group scope. Startup
   rejects an unmarked existing group. For group `-5351770956`, complete
   the reviewed recovery below before enabling the flag.
5. In the private bot chat, the owner sends `/test_allow <numeric Telegram user ID>`
   for each invited tester who has already joined the test group. Each tester
   opens the private bot and sends `/start`. Use `/test_revoke <numeric Telegram user ID>`
   to turn off a tester's access.

## Recover the reviewed legacy test group

Commit `3b74847` stops at `database-scope / TEST_GROUP_SCOPE_ALREADY_IN_USE`
when the configured test group already has a `TelegramGroup` row with
`testOnly=false`. The check also rejects certain legacy rows without a
`TelegramGroup` row. The read-only Neon inspection on 24 November 2026
confirmed the first condition for this incident.

| Reviewed group | Marker and records |
| --- | --- |
| Original `-5305465370` | `testOnly=false` |
| Legacy test `-5351770956` | `testOnly=false`, created 24 November at 10:35:13.137 Yangon. One creator membership belonging to the configured owner, zero test-authorized participants, zero feature records or delivery jobs. |

All 12 migrations were present. This recovery requires no schema migration.
The legacy bot could create the group and membership simply by verifying
access. Those rows are enough to trigger the guard.

1. Keep Render in PRELAUNCH with `TEST_GROUP_ENABLED=false`. Check
   `/healthz` and make sure the old local LIVE poller and any other process
   writing to the test group have stopped.
2. Confirm that `-5351770956` was used exclusively for testing and is still
   the dedicated test chat with the existing bot as an administrator.
3. From the reviewed checkout, connect to the **same Neon database Render
   uses** through its direct endpoint. Substitute the host, role, and
   database name. Enter the password at the prompt.

   ```powershell
   $env:PGSSLMODE = 'require'
   psql -X -W -h <direct-neon-host> -U <role> -d <database> -v confirm_test_group_id=-5351770956 -f scripts/adopt-reviewed-test-group.sql
   ```

   The confirmation authorizes this one operation. The script locks and
   checks the two known IDs, requires the audited test row's creation time
   and owner-only membership, and rejects feature or delivery data that
   appeared after review. It changes only `TelegramGroup.testOnly` for the
   test group. Expect original `f` and test `t`. If any check fails, leave
   the flag off and review the new state before proceeding. The script
   can be retried after a lost connection to confirm a committed adoption.
4. Set `TEST_GROUP_ENABLED=true` with the existing group IDs and restart.
   Verify `/healthz`, run the owner-only `/test_group@unofficial_board_bot`,
   then authorize each tester individually. Prior membership alone grants
   no tester access. If startup still fails, use the startup phase and
   code from the new logs.

To pause testing after recovery, use the existing disable procedure.
Leave the test-only marker in place so a future LIVE configuration
cannot reuse this ID as the original group.

## Scope and delivery

Every feature uses the active Telegram group ID. Existing records and
delivery claims retain their IDs. Child records inherit ownership from a
scoped parent. Global Telegram user IDs are shared identity references.
Membership and feature data are group-scoped. Mini App vote submissions use a test-group idempotency
namespace and resolve retries through the saved parent. Bill and payment
request UUID conflicts fail closed if they reference an incompatible record.
Authorized participant IDs are stored per test group and checked against
current Telegram membership. The configured owner has private access, and
group interactions require current membership.

Group sends and edits validate the owning group's destination at the point
of delivery. The test worker selects and claims only test-owned jobs.
Private payment notifications require current authorization and membership
in that same test group, and contain only a private review link. Payment
proof access also requires the debtor or receiver relationship enforced by
the ledger.

An interrupted send with an unknown outcome is held for manual inspection.
Vote publication remains in `PUBLISHING` when the send outcome is uncertain.
Inspect the test chat before considering any manual recovery to avoid a
duplicate. Existing confirmed rejection paths retain their retry behavior.

Render Free can sleep after 15 minutes without inbound traffic. Telegram
polling is outbound traffic. Open the Render HTTPS `/healthz` endpoint
to wake the service and wait for HTTP 200 before retrying in Telegram.
Queued work persists in Neon. Countdown reminders can be missed after
their grace windows and birthday delivery can be missed after the Yangon
date rolls over. Bill and Hangout delivery or message refresh can wait for
the service to wake. [Render Free web service limitations](https://render.com/docs/free#spinning-down-on-idle)

## Startup diagnostics

| Log phase | What to check |
| --- | --- |
| `ENVIRONMENT_INVALID` | Missing or invalid variable names reported in the log |
| `database-connect` | Existing runtime URL, TLS options, Neon endpoint and network reachability. Prisma `P1001` means the runtime could not reach the database server. |
| `database-scope` | Migration status and the group identity. `P2022` can indicate a missing migration column. `ORIGINAL_GROUP_IS_TEST_ONLY` and `TEST_GROUP_SCOPE_ALREADY_IN_USE` indicate an ownership conflict. Check the safe `scopeReason` field for the affected guard. |
| `telegram-identity` | Existing bot token and Telegram API reachability. `TELEGRAM_401` indicates authorization failure. |
| `telegram-group` | Exact group ID and bot membership. `TEST_GROUP_BOT_ADMIN_REQUIRED` means the test bot must be an administrator. |
| `test-scope-registration` | Test scope reservation, database permissions, or owner membership lookup |
| `telegram-webhook-cleanup` or `telegram-polling-initialize` | Look for the Telegram code. On `TELEGRAM_409`, check for an active webhook or a second bot poller. If a Render handover leaves two pollers, stop the old process before retrying. |
| `http-listen` | Render `PORT` and address binding. `EADDRINUSE` means the port is already bound. |

Prisma connection happens before HTTP listen. The earlier code started HTTP
before Telegraf deleted the webhook and entered long polling, and logged only
the error class. A local database failure and a mocked Telegram polling
conflict can now be distinguished without logging credentials or Telegram
payloads. The exact cause of the previous reported Telegram startup error
requires its original error code or a new reproduction.

## Real Telegram acceptance

1. Confirm the test group diagnostic and short group `/start`. Confirm that
   a test group member who has not been allowed cannot open the private
   controls. Use a synthetic wrong-group fixture for original group
   rejection, or observe the original group silently during acceptance.
2. In Telegram, check the Main Mini App **OPEN** button, blue **The Board**
   button, inline feature shortcuts, reply keyboard toggle, animations and
   dashboard refresh. Confirm Home shows **Test group mode** and feature
   requests use Render. Check AM/PM selection on a real phone.
3. **Smart Poll** and **Group Budget Vote**. Create both drafts in the Mini App.
   Confirm no group post at save. In the private bot, open **My polls** or
   **My budget votes**, select the draft, and tap **Publish to group**. Vote
   in Telegram and from The Board as an allowed tester. Confirm the original
   messages are edited in place and exact MMK amounts are preserved.
4. **Bill Splitter**. Use allowed participants only. Verify one test group
   summary, debt status, private transfer-proof access by the debtor and
   receiver, receiver review and the updated group summary. Use a synthetic
   screenshot. Check that an unrelated allowed tester cannot retrieve it
   and that revoking the receiver blocks future access and queued private
   notices.
5. **Birthday Reminder**. Save and update a test date, then verify the upcoming
   list. For live scheduler acceptance, arrange a test birthday for the
   Yangon date and keep the process awake after 09:00 Yangon. Confirm one
   test group message even across a restart.
6. **Plan Countdown**. Create two independent events. Edit one, cancel the
   other, and verify the 24-hour, 6-hour, 1-hour and start reminders for an
   event scheduled far enough ahead. Confirm original group schedules stay
   untouched.
7. **One Tap Hangout**. Create an invitation and select **Going**, **Maybe** and
   **Can't** across Telegram and The Board. Confirm one invitation updates
   in place and displays the same totals.
8. Keep a test-group view and an original-group view open during the tests.
   Verify all group posts and edits land only in the test group. Revoke a
   tester and verify their next Mini App or bot action is denied.

## Disable or roll back

Set `TEST_GROUP_ENABLED=false`, keep `ACCESS_MODE=PRELAUNCH`, and restart the
existing Render service. Wait for health and verify `testGroupEnabled=false`
in the new process's log. Confirm the prior process has exited before treating
its workers as stopped. Confirm the owner preview works and the diagnostic
and participant access are disabled. Existing test records and claims remain
under the dedicated group. Re-enabling reuses that scope and can resume
eligible queued work.

If the release itself needs rollback, disable test mode before rolling back
to the previous known-good Render deploy. Keep `ACCESS_MODE=PRELAUNCH` and the
original `TELEGRAM_GROUP_ID`. Roll back Vercel to its previous deploy if needed.
Leave the additive database columns and the recorded migration in place.

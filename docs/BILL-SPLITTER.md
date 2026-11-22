# Bill Splitter rollout and operations

## Private use

Open the bot dashboard, choose **Bill Splitter**, then use **Create Bill**.
Choose registered participants and the person who paid, enter whole MMK,
and submit an equal or custom split. Equal remainders go to the lowest
Telegram IDs in order. A selected payer's share is already covered.

In PRELAUNCH, the configured owner gets fictional choices after Telegram
authentication. The form, announcement, debtor and receiver screens, and
ledger can be exercised in memory. Closing the Mini App ends the simulation.

In LIVE, every current member has equal feature access. Opening the private
dashboard registers the member after Telegram verifies their membership.
Roster candidates come from those registrations and each selected member
is rechecked at creation. Make the bot a group administrator for Telegram's
guaranteed membership lookups. [Telegram getChatMember](https://core.telegram.org/bots/api#getchatmember)

Group announcements link to the private bot chat. **View Bill** opens the
bill entry and **Debt Status** opens the ledger entry. Telegram restricts
inline web app buttons to private bot chats.
[Telegram inline keyboard buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton)

## Payment and proof

A debtor can mark Pay Later, then report cash or upload a PNG or JPEG with
**I've Paid**. Transfers require a screenshot. The receiver can confirm
pending payments or request correction. Rejection restores the status
recorded before submission. The receiver can also record cash received
directly. Confirmation settles the full share. All other statuses retain
the original amount outstanding. The ledger reports each debt separately.

The API verifies Telegram initData and current group membership. It then
checks the debtor or receiver on the specific share before returning proof
metadata or bytes. The creator and bot owner have no special proof access.
The API decodes and validates each image, bounds its dimensions and upload
size, and re-encodes it without metadata before storing it as a private
Neon BYTEA value. A share retains up to five submitted screenshots. Keep
the existing Neon storage allowance in mind as proofs accumulate.

Proofs are returned only by signed API POST with no-store headers and
displayed through a temporary in-memory blob. The static frontend ships no
proofs. Telegram notifications contain a private review link and no image,
account information, or payment reference. If the receiver has not started
the bot, the pending payment remains available under **Owed to Me**.

## Announcement delivery

Bill creation and its queue entry commit together. The server checks the
queue after a write, on LIVE startup, and periodically while running. It
claims each item atomically before sending and stores the returned Telegram
message ID. Rate limits are retried with the Telegram delay. A creator can
retry a definitively failed announcement from the bill screen.

Telegram does not provide an idempotency key for sending group messages.
If the process stops during delivery or the outcome is ambiguous, the
queue records UNKNOWN. An operator can reconcile the record with the group
after LIVE activation. Confirm the matching message ID before recording
SENT. Requeue only after establishing that no announcement was delivered.
UNKNOWN items never resend automatically. Use the creator's private bill
view and the delivery row to investigate. Payment review remains usable
through the ledger while Telegram notification delivery is unavailable.

## Deploy after approval

1. Back up or confirm recoverability of the existing Neon database. Check
   migration history from a trusted shell, review
   `20261122223000_group_bill_ledger`, and apply pending migrations only
   after explicit database approval. Rehearse against isolated PostgreSQL
   first. The feature adds five tables, enums, foreign keys, indexes, and
   checks. Existing tables and rows require no backfill.
2. Deploy the reviewed revision to the existing Render service with the
   existing database, token, and canonical Vercel `MINI_APP_URL`. Keep
   `ACCESS_MODE=PRELAUNCH`. The existing build generates Prisma Client
   and installs the Sharp runtime dependency.
3. Deploy the same revision to the existing Vercel project with
   `MINI_APP_API_ORIGIN` set to the Render HTTPS origin. Verify
   `/mini-app/bills?view=create` and API CORS, then check the workflow from
   the owner's Telegram private chat with Preview data.
4. A separate approved LIVE activation enables group messaging and private
   payment review notifications. Render Free can pause while idle. Queued
   delivery resumes when the service starts and processes the queue.

## Local verification

Run the normal tests for calculation, preview policy, and unit coverage.
For delivery, privacy, and concurrent writes against PostgreSQL, apply the
migrations to an isolated local test instance, set
`BILL_TEST_DATABASE_URL` to that loopback instance, and run
`npx vitest run src/features/bill-splitter/ledger.test.ts`. The integration
test inserts synthetic records and mocks Telegram.


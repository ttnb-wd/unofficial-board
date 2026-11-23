# One Tap Hangout

Open **One Tap Hangout** from the private bot dashboard. **Create Hangout** launches the embedded form directly. The date picker includes **Today**, based on Asia/Yangon. Choose a future time, enter a title, and optionally include a place and description. Several hangouts can run concurrently, including at the same time.

**Active Hangouts**, **My Hangouts**, and **Completed Hangouts** show up to eight events per page. A detail screen shows the current member's RSVP, counters, and participant names grouped by response. Only creators can edit or cancel a future hangout. Edits preserve RSVPs and use a version check to prevent stale saves. Cancellation preserves the event and responses. Once the start time arrives, RSVP closes and the event appears in Completed Hangouts if it was active.

## Invitations and RSVP

LIVE saves the event and one invitation job in the same transaction. The group invitation includes the Yangon date and time, optional place and description, counters, **Going**, **Maybe**, **Can't**, and **View Details**. The three RSVP buttons work in the configured Telegram group without opening the Mini App. **View Details** opens the private bot, which offers the embedded details button.

The bot checks current membership and matches the callback to the stored invitation message. The authenticated Telegram account supplies the responder ID. A database constraint enforces one response per event and member, and a newer selection replaces the previous one. Display names are safe text snapshots from the member's latest verified response and are refreshed when the member responds again. A member can also RSVP from authenticated Mini App details.

The worker updates the original invitation when counters or event details change. It attempts to remove RSVP buttons and mark the invitation closed on cancellation or at event start. The server rejects further RSVPs immediately at that point, even if the Telegram post still displays older buttons during reconciliation.

## PRELAUNCH

Only the configured owner can open the signed session. Creation, invitation previews, counters, participant views, and creator and fictional-member actions are simulated in local browser session storage. No preview state is written to PostgreSQL. PRELAUNCH starts no Hangout delivery worker and performs no group membership lookup or message delivery for these previews.

## Database and operations

The additive [One Tap Hangout migration](../prisma/migrations/20261123130000_one_tap_hangout/migration.sql) extends the existing Hangout table and adds RSVP and invitation tables. Legacy Hangout rows are preserved and do not become new invitations. Apply the migration on Neon only after approval and regenerate the Prisma client before a later rollout.

The LIVE worker runs at startup, on the existing 15-second delivery interval, after create and RSVP changes, and when the backend is woken through **/healthz**. The durable send claim uses a second database connection while the first holds the event lock. Definitive rate limits can be retried up to five total send attempts before the start time. An ambiguous send is marked **UNKNOWN** and held for inspection to avoid sending a duplicate. Message edits retry with the latest snapshot, use Telegram's retry delay when available, and stop after permanent failure or five attempts. Deleted or uneditable posts are never replaced automatically. Mini App details remain available.

Render Free can sleep. Publication and counter updates are best-effort until the service is awake. One Tap Hangout has no automatic reminders and is independent of Plan Countdown.

Run the PostgreSQL integration tests with **HANGOUT_TEST_DATABASE_URL** pointing to a migrated loopback database named **hangout_test**. The tests use a stub Telegram client and synthetic groups. The standard suite skips those three integration cases when the test URL is absent.

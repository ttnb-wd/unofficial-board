# Plan Countdown

**Create Countdown** opens a single Telegram Mini App form. Enter a title, a future date and time in Asia/Yangon, and an optional description. Events are independent and may share a date or exact start time. Upcoming, My Events, and Completed Events use eight-event pages. Each visible event card has its own days, hours, minutes and seconds display. Completed Events shows uncancelled plans whose start time has passed. Cancelled events remain in My Events.

Signed Telegram init data identifies the requester. Eligible LIVE group members can view shared plans. Only the creator can edit or cancel a future plan. PRELAUNCH runs an owner-only browser simulation with concurrent and same-time fixtures, upcoming and completed pages, and all reminder and celebration previews. The simulation uses no countdown tables and starts no delivery worker.

## Schedule and delivery

Every new event atomically saves one announcement job and these four UTC milestone records. A milestone already elapsed at creation or rescheduling is recorded as missed.

| Milestone | Grace period after its scheduled time | Example at the milestone |
|---|---:|---|
| 24 hours before | 15 minutes | 🌴 Beach Trip is tomorrow! Only 1 day left! 🎉 |
| 6 hours before | 10 minutes | ⏳ Beach Trip is getting close! 6 hours remaining! |
| 1 hour before | 5 minutes | 🚀 Just 1 hour until Beach Trip! Get ready! |
| Event start | 10 minutes | 🎉 Beach Trip စပြီဟေ့! Enjoy & have fun! 🥳 |

Late advance reminders within their grace period show the time actually remaining. No advance reminder is sent at or after the start. At-start delivery is eligible from the exact event timestamp to ten minutes after it. One of five built-in celebration templates is randomly selected and stored per start job. Retries use that same template.

Delivery identity is the event ID plus the milestone kind. Edits move eligible unsent jobs and leave sent, failed, or ambiguous attempts in history. A milestone that was already sent stays delivered for that event. Cancellation suppresses queued deliveries, including the event-start celebration. The worker and edits lock the same event row. A send already in progress can finish before cancellation takes effect.

The worker persists the exact scheduled time separately from the next retry and attempt times. After Telegram acknowledges a message, its message ID and Telegram's actual send timestamp are stored. Rate-limited attempts can be retried up to five total attempts within the grace window. Expired jobs are marked **MISSED**, and cancelled queued jobs **SKIPPED**. Uncertain results and stale in-flight claims are **UNKNOWN** and require investigation. Telegram offers no idempotency key, so the worker leaves uncertain deliveries alone to avoid duplicate group messages.

## Local and deployment verification

Apply the additive Plan Countdown migrations in order before future LIVE rollout. The milestone migration backfills upcoming events without re-queuing sent history. Old acknowledged jobs keep their message IDs. Actual delivery times for old jobs remain unknown, and historical scheduled times may use the previously stored next-attempt timestamp. Production Neon migration requires separate approval.

The LIVE worker runs at startup, on the shared one-minute Birthday Reminder cadence, and when prompted by creation or an HTTP **/healthz** request. A pass handles up to 20 due jobs, including different events due simultaneously. Its durable claim and event lock use two database connections during a send.

Render Free sleep, queue size, and Telegram rate limits make wake-up and publication best-effort. For timely LIVE reminders, arrange an approved external scheduler to wake **/healthz** before reminder windows or use an approved always-on backend. Exact UTC scheduling is persisted even when delivery occurs later. No external schedule is required for PRELAUNCH.

Run the PostgreSQL integration tests with **COUNTDOWN_TEST_DATABASE_URL** pointing to an isolated, migrated loopback database named **countdown_test** or **countdown_<name>_test**. The tests use synthetic groups and a stub Telegram client. The standard suite skips these two integration cases when the test URL is absent.

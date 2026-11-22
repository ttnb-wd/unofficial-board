# Birthday Reminder

Open **Birthday Reminder** in the bot's private menu. **Add My Birthday** and
**Edit My Birthday** launch the same Mini App directly. Save or remove your own
birthday there. The form stores month and day only. In LIVE, **Upcoming
Birthdays** lists each next occurrence for currently verified members.
In PRELAUNCH, only the configured owner can open the feature. The preview date
is stored separately from LIVE, and the upcoming and announcement previews use
fictional group members. PRELAUNCH never runs the delivery worker or fetches
group membership for this feature.

The calendar uses Asia/Yangon. February 29 is observed on February 28 in
non-leap years and on February 29 in leap years.

## Delivery and recovery

- In LIVE, the worker checks on Render startup and once per minute while
  awake. The delivery window is 09:00–23:59 Yangon time on the observed date.
  A process that wakes later that day can still deliver. The worker does not
  send belated announcements for days missed entirely.
- PostgreSQL uses a unique group/member/calendar-year key and an atomic claim.
  The worker rechecks active group membership and the saved date before
  dispatch. It uses a Telegram inline mention for that member only, escapes
  the display name, and records the returned message ID on success. Removing
  or editing a birthday preserves the annual delivery history. A send already
  claimed and in flight can complete after an edit or removal.
- Explicit Telegram rate limits are retried using the returned retry delay,
  up to five attempts within the delivery window. Membership check failures
  are deferred before a send is attempted. Permanent Telegram rejections are
  recorded as failed. A timeout, lost response, or stale claim becomes
  UNKNOWN because Telegram's sendMessage does not accept an idempotency key.
  Do not requeue UNKNOWN records automatically. Before any manual retry,
  reconcile the group message history, year, and member. An uncertain attempt
  can therefore result in a missed announcement, even when the worker recovers.
- A Render Free web service can sleep without incoming traffic. A timer inside
  that process cannot wake it. If reliable daily delivery is required, arrange
  a separately approved scheduler to GET the existing Render /healthz near
  09:00 Asia/Yangon, allow time for cold starts, and retry failed health checks.
  For a delivery window with operational recovery, schedule additional
  wake-ups that day and monitor logs and persisted FAILED/UNKNOWN rows. The
  health endpoint only confirms service availability. A paid always-on Render
  instance is another option. No scheduler, service, or hosting setting was
  added for this feature.

## Migration

The additive migration **20261123100000_birthday_reminder** creates Birthday
and BirthdayDelivery plus their keys, check, and indexes. It does not rewrite
existing rows. Review and apply it to the intended Neon database only after
approval and before deploying the new backend. Keep ACCESS_MODE=PRELAUNCH
during owner acceptance. The Vercel rewrite for /mini-app/birthday serves the
static form using the existing Render API origin and Telegram authentication.

References: [Render Free services](https://render.com/docs/free) and
[Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).

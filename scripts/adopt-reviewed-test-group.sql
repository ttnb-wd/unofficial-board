\set ON_ERROR_STOP on

-- One-time recovery for the legacy test group reviewed on 2026-11-24.
-- Pass -v confirm_test_group_id=-5351770956 to authorize this specific change.
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT set_config('board_recovery.confirm_group_id', :'confirm_test_group_id', true) AS confirmed_group;

DO $recovery$
DECLARE
  original_id CONSTANT bigint := -5305465370;
  test_id CONSTANT bigint := -5351770956;
  owner_id CONSTANT bigint := 7628120179;
  reviewed_created_at CONSTANT timestamp := TIMESTAMP '2026-11-24 04:05:13.137';
  candidate public."TelegramGroup"%ROWTYPE;
BEGIN
  IF current_setting('board_recovery.confirm_group_id', true) IS DISTINCT FROM test_id::text THEN
    RAISE EXCEPTION 'Confirmation must match the reviewed test group ID';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public."TelegramGroup"
    WHERE "telegramId" = original_id AND NOT "testOnly" FOR SHARE
  ) THEN
    RAISE EXCEPTION 'Expected original group is missing or marked test-only';
  END IF;

  SELECT * INTO candidate FROM public."TelegramGroup"
  WHERE "telegramId" = test_id FOR UPDATE;
  IF NOT FOUND OR candidate."createdAt" <> reviewed_created_at OR candidate."isPrelaunchTest" THEN
    RAISE EXCEPTION 'The database does not contain the reviewed legacy test group row';
  END IF;
  IF candidate."testOnly" THEN
    RAISE NOTICE 'The reviewed test group is already marked test-only';
    RETURN;
  END IF;

  -- The group row lock blocks new references through foreign keys. These three
  -- legacy tables have no group foreign key, so stabilize them for the check.
  LOCK TABLE public."Birthday", public."BirthdayDelivery", public."PlanCountdown" IN SHARE MODE;

  IF NOT EXISTS (
    SELECT 1 FROM public."GroupMembership"
    WHERE "groupId" = test_id AND "memberId" = owner_id
      AND status = 'CREATOR' AND NOT "isPrelaunchTest" AND NOT "testAuthorized"
    FOR UPDATE
  ) OR EXISTS (
    SELECT 1 FROM public."GroupMembership" WHERE "groupId" = test_id AND "memberId" <> owner_id
  ) THEN
    RAISE EXCEPTION 'Test-group membership differs from the reviewed owner-only inventory';
  END IF;

  IF EXISTS (SELECT 1 FROM public."SmartPoll" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."BudgetVote" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."GroupBill" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."Hangout" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."Birthday" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."BirthdayDelivery" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."PlanCountdown" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."MemoryAlbum" WHERE "groupId" = test_id)
    OR EXISTS (SELECT 1 FROM public."MemoryPhoto" WHERE "groupId" = test_id)
  THEN
    RAISE EXCEPTION 'Test-group feature or delivery records appeared since review';
  END IF;

  UPDATE public."TelegramGroup" SET "testOnly" = true
  WHERE "telegramId" = test_id AND NOT "testOnly";
END
$recovery$;

SELECT "telegramId", "testOnly" FROM public."TelegramGroup"
WHERE "telegramId" IN (-5305465370, -5351770956)
ORDER BY "telegramId" DESC;
COMMIT;

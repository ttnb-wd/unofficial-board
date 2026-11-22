CREATE TYPE "SmartPollDraftStep" AS ENUM (
    'QUESTION',
    'OPTIONS',
    'READY',
    'EDIT_QUESTION',
    'EDIT_OPTIONS',
    'ADD_OPTION',
    'SAVED'
);

ALTER TYPE "BudgetDraftStep" ADD VALUE 'SAVED';

ALTER TABLE "SmartPoll"
    ADD COLUMN "draftStep" "SmartPollDraftStep" NOT NULL DEFAULT 'QUESTION';

UPDATE "SmartPoll" AS poll
SET "draftStep" = CASE
    WHEN poll."question" IS NULL THEN 'QUESTION'::"SmartPollDraftStep"
    WHEN EXISTS (
        SELECT 1
        FROM "SmartPollOption" AS option
        WHERE option."pollId" = poll."id"
    ) THEN 'READY'::"SmartPollDraftStep"
    ELSE 'OPTIONS'::"SmartPollDraftStep"
END
WHERE poll."status" = 'DRAFT';

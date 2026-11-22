-- CreateEnum
CREATE TYPE "SmartPollStatus" AS ENUM ('DRAFT', 'PUBLISHING', 'OPEN', 'CLOSING', 'PRELAUNCH_PREVIEW', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BudgetVoteStatus" AS ENUM ('DRAFT', 'PUBLISHING', 'OPEN', 'PRELAUNCH_OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BudgetDraftStep" AS ENUM ('TITLE', 'RANGES', 'HANGOUT', 'READY');

-- CreateEnum
CREATE TYPE "HangoutStatus" AS ENUM ('OPEN', 'CANCELLED', 'COMPLETED');

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TelegramGroup" ADD COLUMN     "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SmartPoll" (
    "id" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "creatorId" BIGINT NOT NULL,
    "question" TEXT,
    "allowsMultipleAnswers" BOOLEAN NOT NULL DEFAULT false,
    "isAnonymous" BOOLEAN NOT NULL DEFAULT true,
    "status" "SmartPollStatus" NOT NULL DEFAULT 'DRAFT',
    "telegramPollId" TEXT,
    "telegramMessageId" INTEGER,
    "promptMessageId" INTEGER,
    "totalVoterCount" INTEGER NOT NULL DEFAULT 0,
    "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SmartPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmartPollOption" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "SmartPollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmartPollVote" (
    "pollId" TEXT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "optionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmartPollVote_pkey" PRIMARY KEY ("pollId","memberId","optionId")
);

-- CreateTable
CREATE TABLE "BudgetVote" (
    "id" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "creatorId" BIGINT NOT NULL,
    "title" TEXT,
    "hangoutId" TEXT,
    "status" "BudgetVoteStatus" NOT NULL DEFAULT 'DRAFT',
    "draftStep" "BudgetDraftStep" NOT NULL DEFAULT 'TITLE',
    "telegramMessageId" INTEGER,
    "promptMessageId" INTEGER,
    "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "BudgetVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetVoteRange" (
    "id" TEXT NOT NULL,
    "budgetVoteId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "minMmk" BIGINT NOT NULL,
    "maxMmk" BIGINT NOT NULL,

    CONSTRAINT "BudgetVoteRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetVoteBallot" (
    "budgetVoteId" TEXT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "rangeId" TEXT NOT NULL,
    "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetVoteBallot_pkey" PRIMARY KEY ("budgetVoteId","memberId")
);

-- CreateTable
CREATE TABLE "Hangout" (
    "id" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "creatorId" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "HangoutStatus" NOT NULL DEFAULT 'OPEN',
    "startsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hangout_pkey" PRIMARY KEY ("id")
);

-- Prevent invalid or overlapping MMK intervals even when rows are inserted outside the bot.
ALTER TABLE "BudgetVoteRange"
ADD CONSTRAINT "BudgetVoteRange_valid_bounds_check"
CHECK ("minMmk" > 0 AND "maxMmk" > "minMmk");

CREATE FUNCTION "reject_overlapping_budget_vote_range"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."budgetVoteId", 0));
    IF EXISTS (
        SELECT 1
        FROM "BudgetVoteRange" AS existing
        WHERE existing."budgetVoteId" = NEW."budgetVoteId"
          AND existing."id" <> NEW."id"
          AND NEW."minMmk" <= existing."maxMmk"
          AND NEW."maxMmk" >= existing."minMmk"
    ) THEN
        RAISE EXCEPTION 'Budget vote ranges cannot overlap'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'BudgetVoteRange_no_overlap';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "BudgetVoteRange_no_overlap_trigger"
BEFORE INSERT OR UPDATE OF "budgetVoteId", "minMmk", "maxMmk"
ON "BudgetVoteRange"
FOR EACH ROW
EXECUTE FUNCTION "reject_overlapping_budget_vote_range"();

-- CreateIndex
CREATE UNIQUE INDEX "SmartPoll_telegramPollId_key" ON "SmartPoll"("telegramPollId");

-- CreateIndex
CREATE INDEX "SmartPoll_groupId_status_createdAt_idx" ON "SmartPoll"("groupId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SmartPoll_creatorId_status_idx" ON "SmartPoll"("creatorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SmartPollOption_pollId_position_key" ON "SmartPollOption"("pollId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "SmartPollOption_pollId_id_key" ON "SmartPollOption"("pollId", "id");

-- CreateIndex
CREATE INDEX "SmartPollVote_pollId_optionId_idx" ON "SmartPollVote"("pollId", "optionId");

-- CreateIndex
CREATE INDEX "BudgetVote_groupId_status_createdAt_idx" ON "BudgetVote"("groupId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BudgetVote_creatorId_status_idx" ON "BudgetVote"("creatorId", "status");

-- CreateIndex
CREATE INDEX "BudgetVote_hangoutId_idx" ON "BudgetVote"("hangoutId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetVoteRange_budgetVoteId_position_key" ON "BudgetVoteRange"("budgetVoteId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetVoteRange_budgetVoteId_id_key" ON "BudgetVoteRange"("budgetVoteId", "id");

-- CreateIndex
CREATE INDEX "BudgetVoteBallot_budgetVoteId_rangeId_idx" ON "BudgetVoteBallot"("budgetVoteId", "rangeId");

-- CreateIndex
CREATE INDEX "Hangout_groupId_status_startsAt_idx" ON "Hangout"("groupId", "status", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Hangout_id_groupId_key" ON "Hangout"("id", "groupId");

-- AddForeignKey
ALTER TABLE "SmartPoll" ADD CONSTRAINT "SmartPoll_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TelegramGroup"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartPoll" ADD CONSTRAINT "SmartPoll_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartPollOption" ADD CONSTRAINT "SmartPollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "SmartPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartPollVote" ADD CONSTRAINT "SmartPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "SmartPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartPollVote" ADD CONSTRAINT "SmartPollVote_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmartPollVote" ADD CONSTRAINT "SmartPollVote_pollId_optionId_fkey" FOREIGN KEY ("pollId", "optionId") REFERENCES "SmartPollOption"("pollId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetVote" ADD CONSTRAINT "BudgetVote_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TelegramGroup"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetVote" ADD CONSTRAINT "BudgetVote_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetVote" ADD CONSTRAINT "BudgetVote_hangoutId_groupId_fkey" FOREIGN KEY ("hangoutId", "groupId") REFERENCES "Hangout"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetVoteRange" ADD CONSTRAINT "BudgetVoteRange_budgetVoteId_fkey" FOREIGN KEY ("budgetVoteId") REFERENCES "BudgetVote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetVoteBallot" ADD CONSTRAINT "BudgetVoteBallot_budgetVoteId_fkey" FOREIGN KEY ("budgetVoteId") REFERENCES "BudgetVote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetVoteBallot" ADD CONSTRAINT "BudgetVoteBallot_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetVoteBallot" ADD CONSTRAINT "BudgetVoteBallot_budgetVoteId_rangeId_fkey" FOREIGN KEY ("budgetVoteId", "rangeId") REFERENCES "BudgetVoteRange"("budgetVoteId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hangout" ADD CONSTRAINT "Hangout_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TelegramGroup"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hangout" ADD CONSTRAINT "Hangout_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

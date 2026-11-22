CREATE TYPE "MiniAppSubmissionFeature" AS ENUM ('SMART_POLL', 'BUDGET_VOTE');

CREATE TABLE "BudgetVoteOption" (
    "id" TEXT NOT NULL,
    "budgetVoteId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "amountMmk" BIGINT NOT NULL,

    CONSTRAINT "BudgetVoteOption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BudgetVoteOption_positive_amount_check" CHECK ("amountMmk" > 0)
);

CREATE TABLE "BudgetVoteOptionBallot" (
    "budgetVoteId" TEXT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "optionId" TEXT NOT NULL,
    "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetVoteOptionBallot_pkey" PRIMARY KEY ("budgetVoteId", "memberId")
);

CREATE TABLE "MiniAppSubmission" (
    "requestId" TEXT NOT NULL,
    "feature" "MiniAppSubmissionFeature" NOT NULL,
    "creatorId" BIGINT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiniAppSubmission_pkey" PRIMARY KEY ("requestId")
);

CREATE UNIQUE INDEX "BudgetVoteOption_budgetVoteId_position_key"
    ON "BudgetVoteOption"("budgetVoteId", "position");

CREATE UNIQUE INDEX "BudgetVoteOption_budgetVoteId_amountMmk_key"
    ON "BudgetVoteOption"("budgetVoteId", "amountMmk");

CREATE UNIQUE INDEX "BudgetVoteOption_budgetVoteId_id_key"
    ON "BudgetVoteOption"("budgetVoteId", "id");

CREATE INDEX "BudgetVoteOptionBallot_budgetVoteId_optionId_idx"
    ON "BudgetVoteOptionBallot"("budgetVoteId", "optionId");

CREATE INDEX "MiniAppSubmission_creatorId_createdAt_idx"
    ON "MiniAppSubmission"("creatorId", "createdAt");

ALTER TABLE "BudgetVoteOption"
    ADD CONSTRAINT "BudgetVoteOption_budgetVoteId_fkey"
    FOREIGN KEY ("budgetVoteId") REFERENCES "BudgetVote"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BudgetVoteOptionBallot"
    ADD CONSTRAINT "BudgetVoteOptionBallot_budgetVoteId_fkey"
    FOREIGN KEY ("budgetVoteId") REFERENCES "BudgetVote"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BudgetVoteOptionBallot"
    ADD CONSTRAINT "BudgetVoteOptionBallot_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("telegramId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BudgetVoteOptionBallot"
    ADD CONSTRAINT "BudgetVoteOptionBallot_budgetVoteId_optionId_fkey"
    FOREIGN KEY ("budgetVoteId", "optionId")
    REFERENCES "BudgetVoteOption"("budgetVoteId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MiniAppSubmission"
    ADD CONSTRAINT "MiniAppSubmission_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Member"("telegramId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

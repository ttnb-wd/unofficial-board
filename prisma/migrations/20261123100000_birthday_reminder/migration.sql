CREATE TYPE "BirthdayDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');

CREATE TABLE "Birthday" (
    "groupId" BIGINT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "preview" BOOLEAN NOT NULL,
    "month" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    CONSTRAINT "Birthday_pkey" PRIMARY KEY ("groupId", "memberId", "preview"),
    CONSTRAINT "Birthday_valid_date" CHECK (
        "month" BETWEEN 1 AND 12 AND "day" BETWEEN 1 AND CASE
            WHEN "month" = 2 THEN 29
            WHEN "month" IN (4, 6, 9, 11) THEN 30
            ELSE 31
        END
    )
);

-- Keep annual delivery history when a member deletes or edits their birthday.
CREATE TABLE "BirthdayDelivery" (
    "groupId" BIGINT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "BirthdayDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptAt" TIMESTAMP(3),
    "telegramMessageId" INTEGER,
    CONSTRAINT "BirthdayDelivery_pkey" PRIMARY KEY ("groupId", "memberId", "year")
);

CREATE INDEX "Birthday_groupId_preview_month_day_idx" ON "Birthday"("groupId", "preview", "month", "day");
CREATE INDEX "BirthdayDelivery_groupId_status_nextAttemptAt_idx" ON "BirthdayDelivery"("groupId", "status", "nextAttemptAt");

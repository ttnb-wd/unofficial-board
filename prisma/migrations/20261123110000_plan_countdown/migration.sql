-- CreateEnum
CREATE TYPE "CountdownDeliveryKind" AS ENUM ('ANNOUNCEMENT', 'DAY_BEFORE', 'HOUR_BEFORE');

-- CreateEnum
CREATE TYPE "CountdownDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'SKIPPED');

-- CreateTable
CREATE TABLE "PlanCountdown" (
    "id" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "creatorId" BIGINT NOT NULL,
    "requestId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "timeZone" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "PlanCountdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanCountdownDelivery" (
    "countdownId" TEXT NOT NULL,
    "kind" "CountdownDeliveryKind" NOT NULL,
    "status" "CountdownDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "attemptAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "telegramMessageId" INTEGER,

    CONSTRAINT "PlanCountdownDelivery_pkey" PRIMARY KEY ("countdownId","kind")
);

-- CreateIndex
CREATE INDEX "PlanCountdown_groupId_startsAt_idx" ON "PlanCountdown"("groupId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanCountdown_groupId_creatorId_requestId_key" ON "PlanCountdown"("groupId", "creatorId", "requestId");

-- CreateIndex
CREATE INDEX "PlanCountdownDelivery_status_nextAttemptAt_idx" ON "PlanCountdownDelivery"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "PlanCountdownDelivery" ADD CONSTRAINT "PlanCountdownDelivery_countdownId_fkey" FOREIGN KEY ("countdownId") REFERENCES "PlanCountdown"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "HangoutRsvp" AS ENUM ('GOING', 'MAYBE', 'CANT');

-- CreateEnum
CREATE TYPE "HangoutInvitationStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'UNKNOWN', 'FAILED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Hangout" ADD COLUMN     "cancelledAt" TIMESTAMPTZ(3),
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "place" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "HangoutResponse" (
    "hangoutId" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "response" "HangoutRsvp" NOT NULL,
    "displayName" TEXT NOT NULL,
    "updateId" BIGINT,
    "respondedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "HangoutResponse_pkey" PRIMARY KEY ("hangoutId","memberId")
);

-- CreateTable
CREATE TABLE "HangoutInvitation" (
    "hangoutId" TEXT NOT NULL,
    "status" "HangoutInvitationStatus" NOT NULL DEFAULT 'QUEUED',
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "attemptAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageId" INTEGER,
    "syncAt" TIMESTAMPTZ(3),
    "syncAttempts" INTEGER NOT NULL DEFAULT 0,
    "unavailableAt" TIMESTAMPTZ(3),

    CONSTRAINT "HangoutInvitation_pkey" PRIMARY KEY ("hangoutId")
);

-- CreateIndex
CREATE INDEX "HangoutResponse_groupId_memberId_idx" ON "HangoutResponse"("groupId", "memberId");

-- CreateIndex
CREATE INDEX "HangoutInvitation_status_nextAttemptAt_idx" ON "HangoutInvitation"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "HangoutInvitation_status_syncAt_idx" ON "HangoutInvitation"("status", "syncAt");

-- CreateIndex
CREATE INDEX "Hangout_groupId_startsAt_id_idx" ON "Hangout"("groupId", "startsAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Hangout_groupId_creatorId_requestId_key" ON "Hangout"("groupId", "creatorId", "requestId");

-- AddForeignKey
ALTER TABLE "HangoutResponse" ADD CONSTRAINT "HangoutResponse_hangoutId_groupId_fkey" FOREIGN KEY ("hangoutId", "groupId") REFERENCES "Hangout"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HangoutResponse" ADD CONSTRAINT "HangoutResponse_groupId_memberId_fkey" FOREIGN KEY ("groupId", "memberId") REFERENCES "GroupMembership"("groupId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HangoutInvitation" ADD CONSTRAINT "HangoutInvitation_hangoutId_fkey" FOREIGN KEY ("hangoutId") REFERENCES "Hangout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


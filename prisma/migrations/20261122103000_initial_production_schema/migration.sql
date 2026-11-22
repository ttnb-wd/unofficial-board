-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "GroupMembershipStatus" AS ENUM ('CREATOR', 'ADMINISTRATOR', 'MEMBER', 'RESTRICTED');

-- CreateTable
CREATE TABLE "Member" (
    "telegramId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "TelegramGroup" (
    "telegramId" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramGroup_pkey" PRIMARY KEY ("telegramId")
);

-- CreateTable
CREATE TABLE "GroupMembership" (
    "groupId" BIGINT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "status" "GroupMembershipStatus" NOT NULL,
    "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("groupId","memberId")
);

-- CreateTable
CREATE TABLE "MemoryAlbum" (
    "id" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "createdByMemberId" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryAlbum_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryPhoto" (
    "id" TEXT NOT NULL,
    "albumId" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "uploadedByMemberId" BIGINT NOT NULL,
    "telegramFileId" TEXT NOT NULL,
    "telegramFileUniqueId" TEXT NOT NULL,
    "caption" TEXT,
    "mimeType" TEXT,
    "isPrelaunchTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupMembership_memberId_idx" ON "GroupMembership"("memberId");

-- CreateIndex
CREATE INDEX "GroupMembership_groupId_status_idx" ON "GroupMembership"("groupId", "status");

-- CreateIndex
CREATE INDEX "MemoryAlbum_groupId_createdAt_idx" ON "MemoryAlbum"("groupId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryAlbum_id_groupId_key" ON "MemoryAlbum"("id", "groupId");

-- CreateIndex
CREATE INDEX "MemoryPhoto_albumId_createdAt_idx" ON "MemoryPhoto"("albumId", "createdAt");

-- CreateIndex
CREATE INDEX "MemoryPhoto_groupId_uploadedByMemberId_idx" ON "MemoryPhoto"("groupId", "uploadedByMemberId");

-- CreateIndex
CREATE INDEX "MemoryPhoto_telegramFileUniqueId_idx" ON "MemoryPhoto"("telegramFileUniqueId");

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TelegramGroup"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryAlbum" ADD CONSTRAINT "MemoryAlbum_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TelegramGroup"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryAlbum" ADD CONSTRAINT "MemoryAlbum_groupId_createdByMemberId_fkey" FOREIGN KEY ("groupId", "createdByMemberId") REFERENCES "GroupMembership"("groupId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryPhoto" ADD CONSTRAINT "MemoryPhoto_albumId_groupId_fkey" FOREIGN KEY ("albumId", "groupId") REFERENCES "MemoryAlbum"("id", "groupId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryPhoto" ADD CONSTRAINT "MemoryPhoto_groupId_uploadedByMemberId_fkey" FOREIGN KEY ("groupId", "uploadedByMemberId") REFERENCES "GroupMembership"("groupId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

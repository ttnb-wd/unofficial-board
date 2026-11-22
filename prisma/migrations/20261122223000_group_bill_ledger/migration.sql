BEGIN;

-- CreateEnum
CREATE TYPE "BillSplitMethod" AS ENUM ('EQUAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BillDebtStatus" AS ENUM ('UNPAID', 'PAY_LATER', 'PENDING_VERIFICATION', 'PAID');

-- CreateEnum
CREATE TYPE "BillPaymentMethod" AS ENUM ('TRANSFER', 'CASH');

-- CreateEnum
CREATE TYPE "BillPaymentDecision" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BillDeliveryStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "GroupBill" (
    "id" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "groupId" BIGINT NOT NULL,
    "creatorId" BIGINT NOT NULL,
    "receiverId" BIGINT NOT NULL,
    "receiverName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "totalMmk" BIGINT NOT NULL,
    "method" "BillSplitMethod" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBillShare" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "memberId" BIGINT NOT NULL,
    "memberName" TEXT NOT NULL,
    "amountMmk" BIGINT NOT NULL,
    "status" "BillDebtStatus" NOT NULL,

    CONSTRAINT "GroupBillShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPayment" (
    "id" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "submittedBy" BIGINT NOT NULL,
    "method" "BillPaymentMethod" NOT NULL,
    "previousStatus" "BillDebtStatus" NOT NULL,
    "decision" "BillPaymentDecision" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" BIGINT,

    CONSTRAINT "BillPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillPaymentProof" (
    "paymentId" TEXT NOT NULL,
    "image" BYTEA NOT NULL,

    CONSTRAINT "BillPaymentProof_pkey" PRIMARY KEY ("paymentId")
);

-- CreateTable
CREATE TABLE "BillDelivery" (
    "id" TEXT NOT NULL,
    "billId" TEXT,
    "paymentId" TEXT,
    "status" "BillDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attemptAt" TIMESTAMP(3),
    "telegramMessageId" INTEGER,
    "failureCode" INTEGER,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupBill_requestId_key" ON "GroupBill"("requestId");

-- CreateIndex
CREATE INDEX "GroupBill_groupId_createdAt_id_idx" ON "GroupBill"("groupId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "GroupBill_creatorId_createdAt_idx" ON "GroupBill"("creatorId", "createdAt");

-- CreateIndex
CREATE INDEX "GroupBill_receiverId_createdAt_idx" ON "GroupBill"("receiverId", "createdAt");

-- CreateIndex
CREATE INDEX "GroupBillShare_memberId_status_billId_idx" ON "GroupBillShare"("memberId", "status", "billId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBillShare_billId_memberId_key" ON "GroupBillShare"("billId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "BillPayment_requestId_key" ON "BillPayment"("requestId");

-- CreateIndex
CREATE INDEX "BillPayment_shareId_createdAt_idx" ON "BillPayment"("shareId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillDelivery_billId_key" ON "BillDelivery"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "BillDelivery_paymentId_key" ON "BillDelivery"("paymentId");

-- CreateIndex
CREATE INDEX "BillDelivery_status_nextAttemptAt_idx" ON "BillDelivery"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "GroupBill" ADD CONSTRAINT "GroupBill_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "TelegramGroup"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBill" ADD CONSTRAINT "GroupBill_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBill" ADD CONSTRAINT "GroupBill_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBillShare" ADD CONSTRAINT "GroupBillShare_billId_fkey" FOREIGN KEY ("billId") REFERENCES "GroupBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBillShare" ADD CONSTRAINT "GroupBillShare_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("telegramId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "GroupBillShare"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillPaymentProof" ADD CONSTRAINT "BillPaymentProof_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillDelivery" ADD CONSTRAINT "BillDelivery_billId_fkey" FOREIGN KEY ("billId") REFERENCES "GroupBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillDelivery" ADD CONSTRAINT "BillDelivery_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GroupBill" ADD CONSTRAINT "GroupBill_total_positive" CHECK ("totalMmk" > 0);
ALTER TABLE "GroupBillShare" ADD CONSTRAINT "GroupBillShare_amount_nonnegative" CHECK ("amountMmk" >= 0);
ALTER TABLE "BillPayment" ADD CONSTRAINT "BillPayment_review_state" CHECK (
  ("decision" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedBy" IS NULL)
  OR ("decision" <> 'PENDING' AND "reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL)
);
ALTER TABLE "BillPaymentProof" ADD CONSTRAINT "BillPaymentProof_image_size" CHECK (octet_length("image") BETWEEN 1 AND 1500000);
ALTER TABLE "BillDelivery" ADD CONSTRAINT "BillDelivery_one_target" CHECK (num_nonnulls("billId", "paymentId") = 1);
CREATE UNIQUE INDEX "BillPayment_one_active_or_confirmed" ON "BillPayment"("shareId")
  WHERE "decision" IN ('PENDING', 'CONFIRMED');

COMMIT;

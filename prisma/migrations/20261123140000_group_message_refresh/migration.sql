ALTER TABLE "SmartPoll" ADD COLUMN "groupSyncAt" TIMESTAMP(3);
CREATE INDEX "SmartPoll_groupSyncAt_idx" ON "SmartPoll" ("groupSyncAt") WHERE "groupSyncAt" IS NOT NULL;
ALTER TABLE "BudgetVote" ADD COLUMN "groupSyncAt" TIMESTAMP(3);
CREATE INDEX "BudgetVote_groupSyncAt_idx" ON "BudgetVote" ("groupSyncAt") WHERE "groupSyncAt" IS NOT NULL;
ALTER TABLE "BillDelivery" ADD COLUMN "groupSyncAt" TIMESTAMP(3);
CREATE INDEX "BillDelivery_groupSyncAt_idx" ON "BillDelivery" ("groupSyncAt") WHERE "groupSyncAt" IS NOT NULL;

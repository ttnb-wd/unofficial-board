ALTER TABLE "PlanCountdownDelivery" ADD COLUMN "syncAt" TIMESTAMPTZ(3);
CREATE INDEX "PlanCountdownDelivery_kind_status_syncAt_idx" ON "PlanCountdownDelivery" ("kind", "status", "syncAt");

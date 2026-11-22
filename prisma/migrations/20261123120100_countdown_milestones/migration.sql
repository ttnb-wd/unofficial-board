ALTER TABLE "PlanCountdownDelivery"
    ADD COLUMN "scheduledAt" TIMESTAMPTZ(3),
    ADD COLUMN "deliveredAt" TIMESTAMPTZ(3),
    ADD COLUMN "startVariant" INTEGER;

-- Preserve historical evidence. Only pending reminders have their old expiry shortened.
UPDATE "PlanCountdownDelivery" AS d
SET "scheduledAt" = CASE
        WHEN d."kind" = 'ANNOUNCEMENT' OR d."status" NOT IN ('QUEUED', 'SKIPPED') THEN d."nextAttemptAt"
        WHEN d."kind" = 'DAY_BEFORE' THEN p."startsAt" - INTERVAL '24 hours'
        ELSE p."startsAt" - INTERVAL '1 hour'
    END,
    "expiresAt" = CASE
        WHEN d."status" = 'QUEUED' AND d."kind" = 'DAY_BEFORE' THEN p."startsAt" - INTERVAL '23 hours 45 minutes'
        WHEN d."status" = 'QUEUED' AND d."kind" = 'HOUR_BEFORE' THEN p."startsAt" - INTERVAL '55 minutes'
        ELSE d."expiresAt"
    END
FROM "PlanCountdown" AS p
WHERE d."countdownId" = p."id";

ALTER TABLE "PlanCountdownDelivery" ALTER COLUMN "scheduledAt" SET NOT NULL;

-- Backfill upcoming events only. Record elapsed milestones as missed without sending them.
INSERT INTO "PlanCountdownDelivery"
    ("countdownId", "kind", "status", "scheduledAt", "nextAttemptAt", "expiresAt", "startVariant")
SELECT p."id", m.kind,
    CASE WHEN p."startsAt" - m.lead < CURRENT_TIMESTAMP THEN 'MISSED' ELSE 'QUEUED' END::"CountdownDeliveryStatus",
    p."startsAt" - m.lead, p."startsAt" - m.lead, p."startsAt" - m.lead + m.grace,
    CASE WHEN m.kind = 'AT_START' THEN floor(random() * 5)::integer END
FROM "PlanCountdown" AS p
CROSS JOIN (VALUES
    ('DAY_BEFORE'::"CountdownDeliveryKind", INTERVAL '24 hours', INTERVAL '15 minutes'),
    ('SIX_HOURS_BEFORE', INTERVAL '6 hours', INTERVAL '10 minutes'),
    ('HOUR_BEFORE', INTERVAL '1 hour', INTERVAL '5 minutes'),
    ('AT_START', INTERVAL '0 seconds', INTERVAL '10 minutes')
) AS m(kind, lead, grace)
WHERE p."cancelledAt" IS NULL AND p."startsAt" > CURRENT_TIMESTAMP
ON CONFLICT ("countdownId", "kind") DO NOTHING;

DROP INDEX "PlanCountdown_groupId_startsAt_idx";
CREATE INDEX "PlanCountdown_groupId_startsAt_id_idx" ON "PlanCountdown"("groupId", "startsAt", "id");
CREATE INDEX "PlanCountdown_groupId_creatorId_startsAt_id_idx" ON "PlanCountdown"("groupId", "creatorId", "startsAt", "id");

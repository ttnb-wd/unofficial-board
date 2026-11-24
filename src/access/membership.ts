import type { PrismaClient } from '@prisma/client';
import type { Telegram } from 'telegraf';
import type { AppConfig } from '../config.js';
import { groupDestination, isOwnerPreview } from './policy.js';

export function testParticipantFilter(config: AppConfig) {
  return config.testGroup ? { OR: [
    { testAuthorized: true }, { memberId: config.prelaunchOwnerId },
  ] } : {};
}

export async function isTestParticipant(db: PrismaClient, config: AppConfig, memberId: bigint) {
  if (!config.testGroup || memberId === config.prelaunchOwnerId) return true;
  const entry = await db.groupMembership.findUnique({
    where: { groupId_memberId: { groupId: config.groupId, memberId } },
    select: { testAuthorized: true },
  });
  return entry?.testAuthorized === true;
}

export async function canAccessBoard(
  telegram: Telegram, db: PrismaClient, config: AppConfig, memberId: bigint, privateChat: boolean,
) {
  if (isOwnerPreview(config)) return privateChat && memberId === config.prelaunchOwnerId;
  if (config.testGroup) {
    groupDestination(config, config.groupId);
    if (privateChat && memberId === config.prelaunchOwnerId) return true;
    if (!await isTestParticipant(db, config, memberId)) return false;
  }
  return verifyAndRecordMembership(telegram, db, config.groupId, memberId, Boolean(config.testGroup));
}

const persistedMembershipStatus = {
  creator: 'CREATOR',
  administrator: 'ADMINISTRATOR',
  member: 'MEMBER',
  restricted: 'RESTRICTED',
} as const;

type PersistedMembershipStatus =
  (typeof persistedMembershipStatus)[keyof typeof persistedMembershipStatus];

export type MembershipStatus = {
  status: string;
  is_member?: boolean;
};

function getPersistedMembershipStatus(
  status: string,
): PersistedMembershipStatus | undefined {
  switch (status) {
    case 'creator':
      return persistedMembershipStatus.creator;
    case 'administrator':
      return persistedMembershipStatus.administrator;
    case 'member':
      return persistedMembershipStatus.member;
    case 'restricted':
      return persistedMembershipStatus.restricted;
    default:
      return undefined;
  }
}

export function hasActiveMembership(
  member: MembershipStatus,
): boolean {
  return (
    getPersistedMembershipStatus(member.status) !== undefined &&
    (member.status !== 'restricted' || member.is_member === true)
  );
}

export async function verifyAndRecordMembership(
  telegram: Telegram,
  database: PrismaClient,
  groupId: bigint,
  memberId: bigint,
  requireHuman = false,
): Promise<boolean> {
  const memberStatus = await telegram.getChatMember(
    groupId.toString(),
    Number(memberId),
  );
  if (!hasActiveMembership(memberStatus) || (requireHuman &&
      (memberStatus.user?.id !== Number(memberId) || memberStatus.user.is_bot))) {
    return false;
  }

  const status = getPersistedMembershipStatus(memberStatus.status);
  if (!status) {
    return false;
  }

  await database.$transaction(async (transaction) => {
    await transaction.telegramGroup.upsert({
      where: { telegramId: groupId },
      create: { telegramId: groupId },
      update: {},
    });
    await transaction.member.upsert({
      where: { telegramId: memberId },
      create: { telegramId: memberId },
      update: {},
    });
    await transaction.groupMembership.upsert({
      where: { groupId_memberId: { groupId, memberId } },
      create: { groupId, memberId, status },
      update: { status, verifiedAt: new Date() },
    });
  });
  return true;
}

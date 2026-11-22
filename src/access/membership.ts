import type { PrismaClient } from '@prisma/client';
import type { Telegram } from 'telegraf';

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
): Promise<boolean> {
  const memberStatus = await telegram.getChatMember(
    groupId.toString(),
    Number(memberId),
  );
  if (!hasActiveMembership(memberStatus)) {
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

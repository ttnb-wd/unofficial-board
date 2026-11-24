import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config.js';
import type { Telegram } from 'telegraf';
import sharp from 'sharp';
import { z } from 'zod';
import { hasActiveMembership, testParticipantFilter } from '../../access/membership.js';
import { BillError, calculateShares, createBillInput, maxProofBytes, outstanding } from './rules.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = () => new BillError(404, 'This record is unavailable.');
const conflict = () => new BillError(409, 'This request no longer matches the saved record.');
type RequestBill = z.output<typeof createBillInput>;
type LedgerView = 'all' | 'debts' | 'received' | 'settled';

async function currentMember(telegram: Telegram, groupId: bigint, id: bigint) {
  const info = await telegram.getChatMember(String(groupId), Number(id));
  if (!hasActiveMembership(info) || info.user.is_bot) return null;
  const name = [info.user.first_name, 'last_name' in info.user ? info.user.last_name : undefined]
    .filter(Boolean).join(' ').replace(/\p{Cc}/gu, ' ').trim();
  return { id: String(id), name: [...name].slice(0, 36).join('') || `Member ${id}` };
}

export async function roster(db: PrismaClient, telegram: Telegram, groupId: bigint, config?: AppConfig) {
  const registered = await db.groupMembership.findMany({
    where: { groupId, isPrelaunchTest: false, ...(config && testParticipantFilter(config)) }, select: { memberId: true }, orderBy: { memberId: 'asc' },
  });
  const active = [];
  for (let index = 0; index < registered.length; index += 5) {
    const batch = await Promise.all(registered.slice(index, index + 5).map(({ memberId }) => currentMember(telegram, groupId, memberId)));
    active.push(...batch.filter((member) => member !== null));
  }
  return active;
}

export async function createBill(db: PrismaClient, telegram: Telegram, groupId: bigint, actor: bigint, input: RequestBill, config?: AppConfig) {
  const shares = calculateShares(input);
  const requestHash = digest([input.title, String(input.total), input.receiverId, input.method,
    shares.map(({ memberId, amount }) => [String(memberId), String(amount)])]);
  const existingBill = (client: Prisma.TransactionClient) =>
    client.groupBill.findUnique({ where: { requestId: input.requestId }, select: { id: true, groupId: true, creatorId: true, requestHash: true } });
  const validateExisting = (existing: NonNullable<Awaited<ReturnType<typeof existingBill>>>) => {
    if (existing.creatorId !== actor || existing.groupId !== groupId || existing.requestHash !== requestHash) throw conflict();
    return { id: existing.id, created: false };
  };
  const existing = await existingBill(db);
  if (existing) return validateExisting(existing);

  const receiverId = BigInt(input.receiverId);
  const ids = [...new Set([receiverId, ...shares.map(({ memberId }) => memberId)])];
  const registered = await db.groupMembership.findMany({
    where: { groupId, memberId: { in: ids }, isPrelaunchTest: false, ...(config && testParticipantFilter(config)) }, select: { memberId: true },
  });
  if (registered.length !== ids.length) throw new BillError(400, 'Each participant and payer must be a registered group member.');
  const names = new Map<bigint, string>();
  for (let index = 0; index < ids.length; index += 5) {
    const batch = await Promise.all(ids.slice(index, index + 5).map((id) => currentMember(telegram, groupId, id)));
    for (const member of batch) {
      if (!member) throw new BillError(400, 'A selected person is no longer an eligible group member. Refresh the roster.');
      names.set(BigInt(member.id), member.name);
    }
  }
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`bill:${input.requestId}`}, 0))::text`;
    const raced = await existingBill(tx);
    if (raced) return validateExisting(raced);
    const bill = await tx.groupBill.create({
      data: {
        groupId, creatorId: actor, receiverId, receiverName: names.get(receiverId)!,
        title: input.title, totalMmk: input.total, method: input.method, requestId: input.requestId, requestHash,
        shares: { create: shares.map(({ memberId, amount, status }) => ({
          memberId, memberName: names.get(memberId)!, amountMmk: amount, status,
        })) },
        delivery: { create: {} },
      },
      select: { id: true },
    });
    return { id: bill.id, created: true };
  }, { isolationLevel: 'ReadCommitted' });
}

function shareView(share: { id: string; memberId: bigint; memberName: string; amountMmk: bigint; status: string }) {
  return {
    id: share.id, debtorId: String(share.memberId), debtor: share.memberName, amount: String(share.amountMmk),
    outstanding: String(outstanding(share.amountMmk, share.status)), status: share.status,
  };
}

export async function myBills(db: PrismaClient, groupId: bigint, actor: bigint, after?: string) {
  const bills = await db.groupBill.findMany({
    where: { groupId, OR: [{ creatorId: actor }, { receiverId: actor }, { shares: { some: { memberId: actor } } }] },
    orderBy: { id: 'desc' }, take: 21, ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    select: { id: true, title: true, totalMmk: true, receiverName: true },
  });
  const items = bills.slice(0, 20).map(({ totalMmk, ...bill }) => ({ ...bill, total: String(totalMmk) }));
  return { items, next: bills.length > 20 ? items.at(-1)!.id : null };
}

export async function ledger(db: PrismaClient, groupId: bigint, actor: bigint, view: LedgerView, after?: string) {
  const rows = await db.groupBillShare.findMany({
    where: {
      bill: { groupId, ...(view === 'received' ? { receiverId: actor } : {}) },
      amountMmk: { gt: 0n }, ...(view === 'debts' ? { memberId: actor } : {}),
      ...(view === 'settled' ? { status: 'PAID', payments: { some: { decision: 'CONFIRMED' } } }
        : view === 'all' ? { OR: [{ status: { not: 'PAID' } }, { payments: { some: { decision: 'CONFIRMED' } } }] }
        : { status: { not: 'PAID' } }),
    },
    orderBy: { id: 'desc' }, take: 21, ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    include: { bill: { select: { id: true, title: true, receiverId: true, receiverName: true } } },
  });
  const items = rows.slice(0, 20).map((row) => ({
    ...shareView(row), billId: row.bill.id, title: row.bill.title, receiver: row.bill.receiverName,
  }));
  return { items, next: rows.length > 20 ? rows[19]!.id : null };
}

export async function getBill(db: PrismaClient, groupId: bigint, actor: bigint, id: string) {
  const bill = await db.groupBill.findUnique({
    where: { id, groupId }, include: {
      shares: { orderBy: { memberId: 'asc' } },
      delivery: { select: { status: true } },
    },
  });
  if (!bill) throw unavailable();
  const privateShares = bill.shares.filter((share) =>
    share.amountMmk > 0n && share.memberId !== bill.receiverId && (actor === share.memberId || actor === bill.receiverId));
  const payments = privateShares.length ? await db.billPayment.findMany({
    where: { shareId: { in: privateShares.map((share) => share.id) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, shareId: true, method: true, decision: true, createdAt: true, reviewedAt: true,
      proof: { select: { paymentId: true } }, delivery: { select: { status: true } } },
  }) : [];
  return {
    id: bill.id, title: bill.title, total: String(bill.totalMmk), receiver: bill.receiverName,
    delivery: bill.creatorId === actor ? bill.delivery?.status ?? null : null,
    shares: bill.shares.map((share) => ({
      ...shareView(share),
      role: share.memberId === bill.receiverId || share.amountMmk === 0n ? null :
        actor === share.memberId ? 'debtor' : actor === bill.receiverId ? 'receiver' : null,
      payments: payments.filter((payment) => payment.shareId === share.id).map(({ proof, delivery, ...payment }) => ({
        ...payment, hasProof: Boolean(proof), notificationStatus: delivery?.status ?? null,
      })),
    })),
  };
}

async function lockShare(tx: Prisma.TransactionClient, groupId: bigint, id: string, actor: bigint, role: 'debtor' | 'receiver') {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT s."id" FROM "GroupBillShare" s JOIN "GroupBill" b ON b."id" = s."billId"
    WHERE s."id" = ${id} AND b."groupId" = ${groupId}
      AND s."memberId" <> b."receiverId" AND s."amountMmk" > 0
      AND (${role} = 'debtor' AND s."memberId" = ${actor} OR ${role} = 'receiver' AND b."receiverId" = ${actor})
    FOR UPDATE OF s`;
  if (!rows.length) throw unavailable();
  return tx.groupBillShare.findUniqueOrThrow({ where: { id } });
}

function refreshAnnouncement(tx: Prisma.TransactionClient, billId: string) {
  return tx.billDelivery.updateMany({ where: { billId }, data: { groupSyncAt: new Date() } });
}

export function payLater(db: PrismaClient, groupId: bigint, actor: bigint, id: string) {
  return db.$transaction(async (tx) => {
    const share = await lockShare(tx, groupId, id, actor, 'debtor');
    if (share.status === 'PAY_LATER') return;
    if (share.status !== 'UNPAID') throw conflict();
    await tx.groupBillShare.update({ where: { id }, data: { status: 'PAY_LATER' } });
    await refreshAnnouncement(tx, share.billId);
  });
}

export async function normalizeProof(encoded: string) {
  if (encoded.length > Math.ceil(maxProofBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new BillError(400, 'Choose a PNG or JPEG image up to 1.5 MB.');
  }
  const input = Buffer.from(encoded, 'base64');
  if (!input.length || input.length > maxProofBytes || input.toString('base64') !== encoded) {
    throw new BillError(400, 'The screenshot data is invalid or too large.');
  }
  try {
    const image = sharp(input, { failOn: 'warning', limitInputPixels: 12_000_000 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new Error('Invalid image');
    const output = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' }).jpeg({ quality: 85 }).toBuffer();
    if (output.length > maxProofBytes) throw new Error('Image too large');
    return new Uint8Array(output);
  } catch {
    throw new BillError(400, 'Choose a readable PNG or JPEG screenshot up to 1.5 MB.');
  }
}

export async function submitPayment(db: PrismaClient, groupId: bigint, actor: bigint, id: string,
  input: { requestId: string; method: 'CASH' | 'TRANSFER'; image?: string | undefined },
  directCash = false,
) {
  const requestHash = digest([id, input.method, input.image ?? null, directCash]);
  const proof = input.image ? await normalizeProof(input.image) : null;
  return db.$transaction(async (tx) => {
    const share = await lockShare(tx, groupId, id, actor, directCash ? 'receiver' : 'debtor');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${input.requestId}`}, 0))::text`;
    const existing = await tx.billPayment.findUnique({ where: { requestId: input.requestId } });
    if (existing) {
      if (existing.shareId !== id || existing.submittedBy !== actor || existing.requestHash !== requestHash) throw conflict();
      return { id: existing.id };
    }
    if (share.status !== 'UNPAID' && share.status !== 'PAY_LATER') throw conflict();
    if (proof && await tx.billPaymentProof.count({ where: { payment: { shareId: id } } }) >= 5) {
      throw new BillError(409, 'This debt has reached its five-screenshot limit.');
    }
    const payment = await tx.billPayment.create({
      data: {
        shareId: id, submittedBy: actor, previousStatus: share.status, method: input.method,
        requestId: input.requestId, requestHash,
        ...(proof ? { proof: { create: { image: proof } } } : {}),
        ...(directCash ? { decision: 'CONFIRMED', reviewedBy: actor, reviewedAt: new Date() } : { delivery: { create: {} } }),
      },
      select: { id: true },
    });
    await tx.groupBillShare.update({ where: { id }, data: { status: directCash ? 'PAID' : 'PENDING_VERIFICATION' } });
    await refreshAnnouncement(tx, share.billId);
    return payment;
  }, { isolationLevel: 'ReadCommitted' });
}

export function reviewPayment(db: PrismaClient, groupId: bigint, actor: bigint, shareId: string, paymentId: string, decision: 'CONFIRMED' | 'REJECTED') {
  return db.$transaction(async (tx) => {
    const share = await lockShare(tx, groupId, shareId, actor, 'receiver');
    const payment = await tx.billPayment.findUnique({ where: { id: paymentId, shareId } });
    if (!payment) throw unavailable();
    if (payment.decision === decision && payment.reviewedBy === actor) return;
    if (payment.decision !== 'PENDING' || share.status !== 'PENDING_VERIFICATION') throw conflict();
    await tx.billPayment.update({ where: { id: paymentId }, data: { decision, reviewedBy: actor, reviewedAt: new Date() } });
    await tx.groupBillShare.update({ where: { id: shareId }, data: { status: decision === 'CONFIRMED' ? 'PAID' : payment.previousStatus } });
    await refreshAnnouncement(tx, share.billId);
  }, { isolationLevel: 'ReadCommitted' });
}

export async function getProof(db: PrismaClient, groupId: bigint, actor: bigint, paymentId: string) {
  const proof = await db.billPaymentProof.findUnique({
    where: { paymentId, payment: { share: {
      bill: { groupId }, OR: [{ memberId: actor }, { bill: { receiverId: actor } }],
    } } }, select: { image: true },
  });
  if (!proof) throw unavailable();
  return proof.image;
}


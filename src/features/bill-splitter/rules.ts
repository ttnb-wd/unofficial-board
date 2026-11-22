import { z } from 'zod';

export const maxProofBytes = 1_500_000;
export const maxParticipants = 30;
export const maxMmk = 999_999_999_999_999n;
const unsigned = z.string().regex(/^(0|[1-9][0-9]{0,14})$/).transform(BigInt);
const memberId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine((id) => Number.isSafeInteger(Number(id)));
export const recordId = z.string().regex(/^[a-z0-9]{1,32}$/);
export const requestId = z.string().uuid().transform((id) => id.toLowerCase());
export const createBillInput = z.object({
  requestId,
  title: z.string().trim().min(1).max(100).refine((text) => !/\p{Cc}/u.test(text)),
  total: unsigned.refine((amount) => amount > 0n && amount <= maxMmk),
  receiverId: memberId,
  method: z.enum(['EQUAL', 'CUSTOM']),
  participants: z.array(z.object({ memberId, share: unsigned.optional() })).min(1).max(maxParticipants),
});

export class BillError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function calculateShares(input: z.output<typeof createBillInput>) {
  const { total, participants, receiverId, method } = input;
  const ordered = [...participants].sort((a, b) => BigInt(a.memberId) < BigInt(b.memberId) ? -1 : a.memberId === b.memberId ? 0 : 1);
  if (new Set(ordered.map(({ memberId }) => memberId)).size !== ordered.length) {
    throw new BillError(400, 'Choose each participant only once.');
  }
  const count = BigInt(ordered.length);
  const shares = ordered.map((participant, index) => {
    const amount = method === 'EQUAL'
      ? total / count + (BigInt(index) < total % count ? 1n : 0n)
      : participant.share;
    if (amount === undefined) throw new BillError(400, 'Enter an amount for every participant.');
    return {
      memberId: BigInt(participant.memberId), amount,
      status: participant.memberId === receiverId || amount === 0n ? 'PAID' as const : 'UNPAID' as const,
    };
  });
  if (shares.reduce((sum, share) => sum + share.amount, 0n) !== total) {
    throw new BillError(400, 'Shares must add up to the bill total.');
  }
  return shares;
}

export function labelStatus(status: string) {
  switch (status) {
    case 'PAID': return 'Paid';
    case 'PAY_LATER': return 'Pay Later';
    case 'PENDING_VERIFICATION': return 'Pending verification';
    default: return 'Unpaid';
  }
}

export const formatMmk = (amount: bigint) => `${amount.toLocaleString('en-US')} MMK`;

export function announcement(bill: {
  title: string; totalMmk: bigint; receiverName: string;
  shares: { memberId: bigint; memberName: string; amountMmk: bigint; status: string }[];
}) {
  const escape = (value: string) => value.replaceAll('@', '＠').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return [
    `<b>${escape(bill.title)}</b>`,
    `Total: ${formatMmk(bill.totalMmk)}`,
    `Paid by: ${escape(bill.receiverName)}`,
    '',
    ...bill.shares.map((s) => `<a href="tg://user?id=${s.memberId}">${escape(s.memberName)}</a> · ${formatMmk(s.amountMmk)} · ${labelStatus(s.status)}`),
  ].join('\n');
}

export function outstanding(amount: bigint, status: string) {
  return status === 'PAID' ? 0n : amount;
}


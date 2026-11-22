import type { PrismaClient } from '@prisma/client';
import type { Telegram } from 'telegraf';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { retryAnnouncement } from './delivery.js';
import { createBill, getBill, getProof, ledger, myBills, payLater, reviewPayment, roster, submitPayment } from './ledger.js';
import { BillError, createBillInput, recordId, requestId } from './rules.js';

const actions = z.discriminatedUnion('action', [
  z.object({ action: z.literal('session') }),
  z.object({ action: z.literal('roster') }),
  z.object({ action: z.literal('create'), bill: createBillInput }),
  z.object({ action: z.literal('mine'), after: recordId.optional() }),
  z.object({ action: z.literal('ledger'), view: z.enum(['all', 'debts', 'received', 'settled']), after: recordId.optional() }),
  z.object({ action: z.literal('bill'), id: recordId }),
  z.object({ action: z.literal('later'), share: recordId }),
  z.object({ action: z.literal('submit'), share: recordId, requestId, method: z.enum(['CASH', 'TRANSFER']), image: z.string().min(1).optional() }),
  z.object({ action: z.literal('proof'), payment: recordId }),
  z.object({ action: z.literal('review'), share: recordId, payment: recordId, decision: z.enum(['CONFIRMED', 'REJECTED']) }),
  z.object({ action: z.literal('cash'), share: recordId, requestId }),
  z.object({ action: z.literal('retry'), id: recordId }),
]);

export const previewRoster = [
  { id: '1', name: 'You (preview)' },
  { id: '2', name: 'Sam (fixture)' },
  { id: '3', name: 'Jules (fixture)' },
];

export async function handleBillAction(body: unknown, actor: bigint, config: AppConfig, db: PrismaClient, telegram: Telegram, kick: () => void) {
  const parsed = actions.safeParse(body);
  if (!parsed.success) throw new BillError(400, 'Check the submitted values and try again.');
  const input = parsed.data;
  if (config.accessMode === 'PRELAUNCH') {
    if (actor !== config.prelaunchOwnerId) throw new BillError(403, 'Access denied.');
    if (input.action === 'session') return { preview: true, actor: '1', roster: previewRoster };
    throw new BillError(403, 'PRELAUNCH simulations run in the Mini App.');
  }

  const { groupId } = config;
  switch (input.action) {
    case 'session': return { preview: false, actor: String(actor) };
    case 'roster': return { roster: await roster(db, telegram, groupId) };
    case 'create': {
      const result = await createBill(db, telegram, groupId, actor, input.bill);
      kick();
      return result;
    }
    case 'mine': return myBills(db, groupId, actor, input.after);
    case 'ledger': return ledger(db, groupId, actor, input.view, input.after);
    case 'bill': return getBill(db, groupId, actor, input.id);
    case 'later':
      await payLater(db, groupId, actor, input.share);
      return { ok: true };
    case 'submit':
      if (Boolean(input.image) !== (input.method === 'TRANSFER')) {
        throw new BillError(400, 'Transfer submissions require a screenshot. Cash submissions do not.');
      }
      {
        const result = await submitPayment(db, groupId, actor, input.share, input);
        kick();
        return result;
      }
    case 'proof': return getProof(db, groupId, actor, input.payment);
    case 'review':
      await reviewPayment(db, groupId, actor, input.share, input.payment, input.decision);
      return { ok: true };
    case 'cash':
      return submitPayment(db, groupId, actor, input.share, { requestId: input.requestId, method: 'CASH' }, true);
    case 'retry':
      await retryAnnouncement(db, groupId, actor, input.id);
      kick();
      return { ok: true };
  }
}


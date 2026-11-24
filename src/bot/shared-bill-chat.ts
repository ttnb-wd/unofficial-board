import type { Context, Telegraf } from 'telegraf';
import type { PrismaClient } from '@prisma/client';
import { allowsGroupWorkflows } from '../access/policy.js';
import type { AppConfig } from '../config.js';
import { handleBillAction } from '../features/bill-splitter/api.js';
import { getBill, ledger, myBills, roster } from '../features/bill-splitter/ledger.js';
import { BillError, formatMmk, labelStatus, maxProofBytes } from '../features/bill-splitter/rules.js';
import { button, privateFeature, privateScreen, requestFor } from './shared-event-chat.js';
import type { PrivateAccess } from './shared-event-chat.js';

const views = { mine: 'My Bills', all: 'Group Debt Ledger', debts: 'My Debts', received: 'Owed to Me', settled: 'Settled History' } as const;
type View = keyof typeof views;
const usage = 'Create with /billcreate Title | total MMK | payer ID | participant IDs separated by commas.\n' +
  'For custom shares, enter ID=amount for each participant. Use /billmembers to find IDs.';
const mmk = (amount: string) => formatMmk(BigInt(amount));
const record = '[a-z0-9]{1,32}';

async function photoBytes(ctx: Context, fileId: string) {
  try {
    const url = await ctx.telegram.getFileLink(fileId);
    if (url.protocol !== 'https:' || url.hostname !== 'api.telegram.org') throw new Error();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(9000) });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxProofBytes) throw new Error();
    const parts: Uint8Array[] = [];
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxProofBytes) {
          await reader.cancel();
          throw new Error();
        }
        parts.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(parts).toString('base64');
  } catch {
    // Telegram file URLs contain the bot token.
    throw new BillError(400, 'Could not read that photo. Send a readable screenshot up to 1.5 MB.');
  }
}

export function registerSharedBillChat(
  bot: Telegraf, config: AppConfig, db: PrismaClient, authorize: PrivateAccess, wake: () => void,
) {
  const { groupId } = config;
  const action = (ctx: Context, id: bigint, body: unknown) => handleBillAction(body, id, config, db, ctx.telegram, wake);
  async function guard(ctx: Context, work: (actor: bigint) => Promise<unknown>) {
    const actor = await privateFeature(ctx, authorize);
    if (actor === null || !allowsGroupWorkflows(config)) return;
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    try {
      await work(actor);
    } catch (error) {
      if (!(error instanceof BillError)) throw error;
      await ctx.reply(error.message);
    }
  }

  async function list(ctx: Context, actor: bigint, view: View, after?: string) {
    const result = view === 'mine' ? await myBills(db, groupId, actor, after) : await ledger(db, groupId, actor, view, after);
    await privateScreen(ctx, 'Bill Splitter · ' + views[view] + (result.items.length ? '' : '\nNo entries.'), [
      [button('My bills', 'ebl:mine'), button('Group debts', 'ebl:all')],
      [button('My debts', 'ebl:debts'), button('Owed to me', 'ebl:received'), button('Settled', 'ebl:settled')],
      ...result.items.map((item) => [button([...item.title].slice(0, 27).join('') + ' · ' +
        ('outstanding' in item ? mmk(item.outstanding) + ' · ' + labelStatus(item.status) : mmk(item.total)),
      'ebd:' + ('billId' in item ? item.billId : item.id))]),
      [button('Refresh', 'ebl:' + view + (after ? ':' + after : '')), button('Create in chat', 'ebl:create')],
      ...(result.next ? [[button('Next', 'ebl:' + view + ':' + result.next)]] : []),
    ]);
  }

  async function detail(ctx: Context, actor: bigint, id: string, notice = '') {
    const bill = await getBill(db, groupId, actor, id);
    const lines = [notice, bill.title, mmk(bill.total) + ' · Paid by ' + bill.receiver,
      bill.delivery ? 'Group announcement: ' + (bill.delivery === 'UNKNOWN' ? 'delivery unconfirmed' : bill.delivery.toLowerCase()) : ''];
    const rows: ReturnType<typeof button>[][] = [[button('Refresh', 'ebd:' + id)]];
    if (bill.delivery === 'FAILED') rows.push([button('Retry announcement', 'ebx:retry:' + id)]);
    for (const share of bill.shares) {
      lines.push(share.debtor + ' · ' + mmk(share.amount) + ' · ' + labelStatus(share.status));
      if (share.role) {
        const reviewed = share.payments[0];
        if (reviewed) lines.push('Latest ' + reviewed.method.toLowerCase() + ' report: ' + reviewed.decision.toLowerCase());
        rows.push([button('Payment actions · ' + share.debtor, 'ebx:share:' + share.id)]);
      }
    }
    await privateScreen(ctx, lines.filter(Boolean).join('\n'), rows, 'ebl:mine');
  }

  async function paymentRecord(actor: bigint, id: string) {
    return db.billPayment.findFirst({ where: { id, share: { bill: { groupId, receiverId: actor } } }, select: { shareId: true, share: { select: { billId: true } } } });
  }

  async function shareScreen(ctx: Context, actor: bigint, id: string) {
    const parent = await db.groupBillShare.findFirst({
      where: { id, bill: { groupId }, OR: [{ memberId: actor }, { bill: { receiverId: actor } }] }, select: { billId: true },
    });
    if (!parent) throw new BillError(404, 'This share is unavailable.');
    const bill = await getBill(db, groupId, actor, parent.billId);
    const share = bill.shares.find((item) => item.id === id && item.role);
    if (!share) throw new BillError(404, 'This share is unavailable.');
    const rows: ReturnType<typeof button>[][] = [[button('Refresh', 'ebx:share:' + id)]];
    const lines = [bill.title, share.debtor + ' · ' + mmk(share.amount) + ' · ' + labelStatus(share.status)];
    if (share.role === 'debtor' && ['UNPAID', 'PAY_LATER'].includes(share.status)) {
      rows.push([button('Report cash payment', 'ebx:cash:' + id), button('Pay later', 'ebx:later:' + id)]);
      lines.push('For transfer proof, send a photo here with the caption /billproof ' + id + '.');
    }
    for (const [index, payment] of share.payments.slice(0, 10).entries()) {
      lines.push((index + 1) + '. ' + payment.method + ' · ' + payment.decision);
      if (payment.hasProof) rows.push([button('View private proof ' + (index + 1), 'ebx:proof:' + payment.id)]);
      if (payment.decision === 'PENDING' && share.role === 'receiver') rows.push([
        button('Confirm received', 'ebx:confirm:' + payment.id), button('Request correction', 'ebx:reject:' + payment.id),
      ]);
    }
    await privateScreen(ctx, lines.join('\n'), rows, 'ebd:' + bill.id);
  }

  bot.command('bills', (ctx) => guard(ctx, (actor) => list(ctx, actor, 'mine')));
  bot.command('billmembers', (ctx) => guard(ctx, async () => {
    const members = await roster(db, ctx.telegram, groupId, config);
    const rows = members.map(({ name, id }) => name + ' · ' + id);
    for (let offset = 0; offset < rows.length || offset === 0; offset += 35) {
      await ctx.reply(['Registered group members', ...rows.slice(offset, offset + 35)].join('\n'));
    }
  }));
  bot.command('billcreate', (ctx) => guard(ctx, async (actor) => {
    const [title, total, receiverId, people, ...extra] = ctx.payload.split('|').map((value) => value.trim());
    if (!title || !total || !receiverId || !people || extra.length) { await ctx.reply(usage); return; }
    const method = people.includes('=') ? 'CUSTOM' : 'EQUAL';
    const participants = people.split(',').map((value) => {
      const [memberId, share, ...rest] = value.trim().split('=');
      return { memberId, share: rest.length ? 'invalid' : share };
    });
    const result = await action(ctx, actor, { action: 'create', bill: { title, total, receiverId, participants, method, requestId: requestFor(ctx) } });
    if ('id' in result && typeof result.id === 'string') await detail(ctx, actor, result.id, 'Bill saved.');
  }));
  bot.on('photo', async (ctx, next) => {
    const caption = ctx.message.caption?.trim() ?? '';
    const match = new RegExp('^/billproof\\s+(' + record + ')$').exec(caption);
    if (ctx.chat.type !== 'private' || !match) return next();
    await guard(ctx, async (actor) => {
      const id = match[1]!;
      const share = await db.groupBillShare.findFirst({
        where: { id, memberId: actor, bill: { groupId } }, select: { id: true },
      });
      if (!share) throw new BillError(404, 'This share is unavailable.');
      const photo = [...ctx.message.photo].reverse().find((item) => (item.file_size ?? 0) <= maxProofBytes);
      if (!photo) throw new BillError(400, 'Choose a screenshot up to 1.5 MB.');
      const image = await photoBytes(ctx, photo.file_id);
      await action(ctx, actor, { action: 'submit', share: id, requestId: requestFor(ctx), method: 'TRANSFER', image });
      await shareScreen(ctx, actor, id);
    });
  });
  bot.action(new RegExp('^ebl:(mine|all|debts|received|settled|create)(?::(' + record + '))?$'), (ctx) =>
    guard(ctx, async (actor) => {
      if (ctx.match[1] === 'create') { await ctx.reply(usage); return; }
      await list(ctx, actor, ctx.match[1] as View, ctx.match[2]);
    }));
  bot.action(new RegExp('^ebd:(' + record + ')$'), (ctx) => guard(ctx, (actor) => detail(ctx, actor, ctx.match[1]!)));
  bot.action(new RegExp('^ebx:(share|later|cash|proof|confirm|reject|retry):(' + record + ')$'), (ctx) =>
    guard(ctx, async (actor) => {
      const operation = ctx.match[1];
      const id = ctx.match[2]!;
      if (operation === 'share') { await shareScreen(ctx, actor, id); return; }
      if (operation === 'retry') {
        await action(ctx, actor, { action: 'retry', id });
        await detail(ctx, actor, id);
        return;
      }
      if (operation === 'later' || operation === 'cash') {
        await action(ctx, actor, operation === 'later' ? { action: 'later', share: id }
          : { action: 'submit', share: id, method: 'CASH', requestId: requestFor(ctx) });
        await shareScreen(ctx, actor, id);
        return;
      }
      if (operation === 'proof') {
        const result = await action(ctx, actor, { action: 'proof', payment: id });
        if (result instanceof Uint8Array) await ctx.replyWithPhoto({ source: Buffer.from(result) }, { protect_content: true });
        return;
      }
      const payment = await paymentRecord(actor, id);
      if (!payment) throw new BillError(404, 'This payment is unavailable.');
      await action(ctx, actor, { action: 'review', share: payment.shareId, payment: id,
        decision: operation === 'confirm' ? 'CONFIRMED' : 'REJECTED' });
      await shareScreen(ctx, actor, payment.shareId);
    }));
  bot.start((ctx, next) => {
    const match = new RegExp('^bill_(ledger|' + record + ')$').exec(ctx.payload);
    if (!match || !allowsGroupWorkflows(config)) return next();
    return guard(ctx, (actor) => match[1] === 'ledger' ? list(ctx, actor, 'all') : detail(ctx, actor, match[1]!));
  });
  bot.action('native:bill', (ctx) => guard(ctx, (actor) => list(ctx, actor, 'mine')));
}

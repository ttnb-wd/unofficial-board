import { isOwnerPreview } from '../access/policy.js';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { canViewPublished, loadVote, memberSelection, publishedVotes, saveBallot, validSelection } from '../features/vote-store.js';
import type { Kind, VoteRecord } from '../features/vote-store.js';

const kind = z.enum(['poll', 'bv']);
const id = z.string().regex(/^[a-z0-9]{1,30}$/);
const actions = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), kind, page: z.number().int().min(0).max(9999) }),
  z.strictObject({ action: z.literal('detail'), kind, id }),
  z.strictObject({ action: z.literal('submit'), kind, id, mask: z.number().int().min(1).max(1023) }),
]);

const reject = (status: number, error: string) => ({ status, body: { error } });
const accept = <T>(body: T) => ({ status: 200, body });
const pageSize = 10;

async function list(database: PrismaClient, config: AppConfig, userId: bigint, kind: Kind, page: number) {
  const preview = isOwnerPreview(config);
  const where = preview
    ? { groupId: config.groupId, creatorId: userId, isPrelaunchTest: true, options: { some: { position: 1 } } }
    : publishedVotes(config.groupId);
  const query = {
    skip: page * pageSize, take: pageSize + 1,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  };
  const records = kind === 'poll'
    ? (await database.smartPoll.findMany({
      ...query, where: { ...where, question: { not: null } },
      select: { id: true, question: true, status: true },
    })).map(({ question, ...record }) => ({ ...record, title: question }))
    : await database.budgetVote.findMany({
      ...query, where: { ...where, title: { not: null } },
      select: { id: true, title: true, status: true },
    });
  return { preview, records: records.slice(0, pageSize), more: page < 9999 && records.length > pageSize };
}

function present(record: VoteRecord, preview: boolean, mask: number, saved: boolean) {
  return {
    title: record.title, preview, multiple: record.multiple,
    open: preview || record.status === 'OPEN', custom: record.custom,
    choices: record.choices.map(({ label, count }, index) => ({
      label,
      count: preview ? Number(saved && Boolean(mask & (1 << index))) : record.countsAvailable ? count : null,
    })),
    total: preview ? Number(saved) : record.total,
    mask,
  };
}

export async function handleVoteAction(
  body: unknown, userId: bigint, config: AppConfig, database: PrismaClient, botUsername?: string,
) {
  const parsed = actions.safeParse(body);
  if (!parsed.success) return reject(400, 'Choose a valid vote and selection.');
  const input = parsed.data;
  const preview = isOwnerPreview(config);
  if (preview && userId !== config.prelaunchOwnerId) return reject(403, 'Owner preview only.');
  if (input.action === 'list') {
    const result = await list(database, config, userId, input.kind, input.page);
    const managementUrl = botUsername && /^[a-zA-Z0-9_]+$/.test(botUsername)
      ? `https://t.me/${botUsername}?start=${input.kind === 'poll' ? 'polls' : 'budgets'}` : undefined;
    return accept({ ...result, managementUrl });
  }

  const record = await loadVote(database, config.groupId, input.kind, input.id);
  const allowed = record && (preview
    ? record.creatorId === userId && record.isPrelaunchTest && record.ready
    : canViewPublished(config, record));
  if (!record || !allowed) return reject(404, 'This vote is unavailable.');
  const botUrl = !preview && !record.custom && botUsername && /^[a-zA-Z0-9_]+$/.test(botUsername)
    ? `https://t.me/${botUsername}?start=vote_${input.kind}_${record.id}` : undefined;
  if (input.action === 'detail') {
    const mask = !preview && record.custom ? await memberSelection(database, input.kind, record, userId) : 0;
    return accept({ ...present(record, preview, mask, false), botUrl });
  }
  if (!validSelection(record, input.mask, true)) return reject(400, 'Choose a valid option.');
  if (preview) return accept(present(record, true, input.mask, true));
  if (!await saveBallot(database, config, input.kind, record, userId, input.mask)) {
    return reject(409, 'This ballot changed or closed. Reopen it for the latest results.');
  }
  const latest = await loadVote(database, config.groupId, input.kind, input.id);
  return accept(present(latest ?? record, false, input.mask, true));
}

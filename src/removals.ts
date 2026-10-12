import type { ModActionType, TriggerContext } from '@devvit/public-api';
import { z } from 'zod';
import { expiresAt, globalKeys, type RemovedItem } from './backtest-store.js';
import { diagnosticFailure, failureMetadata, failureReason } from './diagnostics.js';
import { buildEvidence, isExcludedAuthor } from './evidence.js';
import { RETENTION_MS } from './storage.js';
import { subredditName } from './subreddit.js';
import { normalize } from './watch.js';
import { isWorkThread } from './work-threads.js';

const REMOVALS: ModActionType[] = ['removelink', 'spamlink', 'removecomment', 'spamcomment'];

const BACKFILL = 'backfill-removals';

const pending = z.array(z.object({ id: z.string(), removedAt: z.number(), reason: z.string().optional() }));

export function isHumanModerator(name: string, appSlug: string): boolean {
  return !['automoderator', 'reddit', 'anti-evil operations', '', appSlug.toLowerCase()].includes(name.toLowerCase());
}

export async function keepRemoved(id: string, removedAt: number, reason: string | undefined, context: TriggerContext): Promise<void> {
  if (await context.settings.get<boolean>('processing-approved') !== true) return;
  const item = id.startsWith('t1_') ? await context.reddit.getCommentById(id) : await context.reddit.getPostById(id);
  const post = 'parentId' in item ? await context.reddit.getPostById(item.postId) : item;

  if (!(item.removed || item.spam) || isExcludedAuthor(item.authorName, context.appSlug)) return;

  if (['[deleted]', '[removed]'].includes(item.body ?? '') || !normalize(`${'parentId' in item ? '' : post.title} ${item.body ?? ''}`)) {
    console.log('[rule-watch] removed_text_unavailable', { id });

    return;
  }

  const sources = new Set([id, post.id]);
  const workTitle = (await context.settings.get<string>('work-thread-title'))?.trim() ?? '';

  const evidence = await buildEvidence(item, post, workTitle ? await isWorkThread(post, workTitle, context) : false, (parentId) => {
    sources.add(parentId);

    return context.reddit.getCommentById(parentId);
  });

  const record: RemovedItem = { id, subreddit: await subredditName(context), removedAt, evidence };

  if (reason) record.reason = reason;
  const expiration = expiresAt(removedAt);
  await context.redis.global.set(globalKeys.record(id), JSON.stringify(record), { expiration });
  await context.redis.global.zAdd(globalKeys.removed, { member: id, score: removedAt });

  for (const source of sources) {
    await context.redis.global.zAdd(globalKeys.sources(source), { member: id, score: removedAt });
    await context.redis.global.expire(globalKeys.sources(source), RETENTION_MS / 1000);
  }

  console.log('[rule-watch] removed_item_kept', { id, reason: Boolean(reason) });
}

export async function attachReason(id: string, context: TriggerContext): Promise<void> {
  const raw = await context.redis.global.get(globalKeys.record(id));

  if (!raw) return;
  const entries = await context.reddit.getModerationLog({ subredditName: await subredditName(context), type: 'addremovalreason', limit: 25 }).all();
  const entry = entries.find((action) => action.target?.id === id);
  const reason = entry?.details || entry?.description;
  console.log('[rule-watch] removal_reason', { id, found: Boolean(reason) });

  if (!reason) return;
  const record: RemovedItem = { ...JSON.parse(raw), reason };
  await context.redis.global.set(globalKeys.record(id), JSON.stringify(record), { expiration: expiresAt(record.removedAt) });
}

export async function forgetRemoved(id: string, context: Pick<TriggerContext, 'redis'>): Promise<void> {
  const dependents = await context.redis.global.zRange(globalKeys.sources(id), 0, -1, { by: 'rank' });
  const records = [id, ...dependents.map((entry) => entry.member)];
  await context.redis.global.del(...records.map(globalKeys.record), globalKeys.sources(id));
  await context.redis.global.zRem(globalKeys.removed, records);
}

export async function startBackfill(context: TriggerContext): Promise<void> {
  if (await context.settings.get<boolean>('processing-approved') !== true) return;
  const name = await subredditName(context);
  const since = Date.now() - RETENTION_MS;
  const reasons = new Map<string, string>();
  const removals = new Map<string, z.infer<typeof pending>[number]>();

  for (const action of await context.reddit.getModerationLog({ subredditName: name, type: 'addremovalreason', limit: 500, pageSize: 100 }).all()) {
    const reason = action.details || action.description;

    if (action.target?.id && reason && !reasons.has(action.target.id)) reasons.set(action.target.id, reason);
  }

  for (const type of REMOVALS) {
    for (const action of await context.reddit.getModerationLog({ subredditName: name, type, limit: 500, pageSize: 100 }).all()) {
      const id = action.target?.id;

      if (!id || action.createdAt.getTime() < since || removals.has(id) || !isHumanModerator(action.moderatorName, context.appSlug)) continue;
      removals.set(id, { id, removedAt: action.createdAt.getTime(), reason: reasons.get(id) });
    }
  }

  await context.redis.set(BACKFILL, JSON.stringify([...removals.values()]), { expiration: new Date(Date.now() + 86_400_000) });
  console.log('[rule-watch] removal_backfill_started', { count: removals.size });
  await context.scheduler.runJob({ name: BACKFILL, runAt: new Date() });
}

export async function continueBackfill(context: TriggerContext): Promise<void> {
  const deadline = Date.now() + 18_000;
  const queue = pending.parse(JSON.parse(await context.redis.get(BACKFILL) ?? '[]'));

  while (queue.length && Date.now() < deadline) {
    await Promise.all(queue.splice(0, 5).map(({ id, removedAt, reason }) => keepRemoved(id, removedAt, reason, context).catch((error) => {
      diagnosticFailure('removal_backfill_failed', failureMetadata.parse(error), failureReason.parse(error));
    })));
  }

  if (!queue.length) {
    await context.redis.del(BACKFILL);
    console.log('[rule-watch] removal_backfill_done');

    return;
  }

  await context.redis.set(BACKFILL, JSON.stringify(queue), { expiration: new Date(Date.now() + 86_400_000) });
  await context.scheduler.runJob({ name: BACKFILL, runAt: new Date(Date.now() + 1000) });
}

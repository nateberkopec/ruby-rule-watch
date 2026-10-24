import type { TriggerContext } from '@devvit/public-api';
import { z } from 'zod';

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const INDEX = 'assessments';

const assessment = z.object({
  id: z.string(),
  contentId: z.string(),
  kind: z.enum(['post', 'comment']),
  permalink: z.url(),
  assessedAt: z.number(),
  configuration: z.string(),
  scores: z.record(z.string(), z.number().min(0).max(1)),
  flagged: z.array(z.string()),
  delivery: z.enum(['none', 'suppressed', 'capped', 'reported', 'failed']),
  outcome: z.enum(['removed', 'approved']).optional(),
});

export type Assessment = z.infer<typeof assessment>;

type StorageContext = Pick<TriggerContext, 'redis'>;

export async function saveAssessment(record: Assessment, context: StorageContext): Promise<void> {
  const expiration = new Date(record.assessedAt + RETENTION_MS);
  await context.redis.set(`assessment:${record.id}`, JSON.stringify(record), { expiration });
  await context.redis.set(`latest:${record.contentId}`, record.id, { expiration });
  await context.redis.zAdd(INDEX, { member: record.id, score: record.assessedAt });
}

export async function recordOutcome(contentId: string, outcome: 'removed' | 'approved', context: StorageContext): Promise<boolean> {
  const id = await context.redis.get(`latest:${contentId}`);
  const raw = id ? await context.redis.get(`assessment:${id}`) : undefined;

  if (!raw) return false;
  const record = assessment.parse(JSON.parse(raw));
  record.outcome = outcome;
  await saveAssessment(record, context);

  return true;
}

export async function cleanup(context: StorageContext): Promise<void> {
  await context.redis.zRemRangeByScore(INDEX, 0, Date.now() - RETENTION_MS);
}

export async function retainedAssessments(context: StorageContext): Promise<Assessment[]> {
  await cleanup(context);
  const entries = await context.redis.zRange(INDEX, 0, -1, { by: 'rank' });

  if (!entries.length) return [];
  const values = await context.redis.mGet(entries.map((entry) => `assessment:${entry.member}`));

  return values.flatMap((value) => value ? [assessment.parse(JSON.parse(value))] : []);
}

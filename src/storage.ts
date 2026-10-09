import type { TriggerContext } from '@devvit/public-api';
import { z } from 'zod';
import { rules } from './rules.js';

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const INDEX = 'assessments';

const ruleName = z.enum(rules.map((rule) => rule.name));

const assessment = z.object({
  id: z.string(),
  contentId: z.string(),
  kind: z.enum(['post', 'comment']),
  permalink: z.url(),
  assessedAt: z.number(),
  configuration: z.string(),
  mode: z.enum(['shadow', 'live']),
  scores: z.partialRecord(ruleName, z.number().min(0).max(1)),
  flagged: z.array(ruleName),
  delivery: z.enum(['none', 'attempted', 'sent', 'failed', 'suppressed']),
  feedback: z.enum(['useful', 'not_useful']).optional(),
});

export type Assessment = z.infer<typeof assessment>;

type StorageContext = Pick<TriggerContext, 'redis'>;

export async function saveAssessment(record: Assessment, context: StorageContext): Promise<void> {
  await context.redis.set(`assessment:${record.id}`, JSON.stringify(record), {
    expiration: new Date(record.assessedAt + RETENTION_MS),
  });
  await context.redis.zAdd(INDEX, { member: record.id, score: record.assessedAt });
}

export async function getAssessment(id: string, context: StorageContext): Promise<Assessment | undefined> {
  const raw = await context.redis.get(`assessment:${id}`);

  return raw ? assessment.parse(JSON.parse(raw)) : undefined;
}

export async function cleanup(context: StorageContext): Promise<void> {
  await context.redis.zRemRangeByScore(INDEX, 0, Date.now() - RETENTION_MS);
}

export async function recentAssessments(context: StorageContext): Promise<Assessment[]> {
  await cleanup(context);
  const entries = await context.redis.zRange(INDEX, 0, 199, { by: 'rank', reverse: true });
  const records = await Promise.all(entries.map((entry) => getAssessment(entry.member, context)));

  return records.filter((record): record is Assessment => record !== undefined);
}

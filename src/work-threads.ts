import type { TriggerContext } from '@devvit/public-api';
import { z } from 'zod';

export const WORK_PATTERN_KEY = 'work-pattern';

const workPattern = z.object({
  titlePrefix: z.string().trim().min(1),
  titleSuffix: z.string(),
  author: z.string().regex(/^[\w-]{1,64}$/),
  anchorUtc: z.iso.datetime({ precision: 0 }),
  toleranceMinutes: z.number().min(0).max(60),
});

export type WorkPattern = z.infer<typeof workPattern>;

export async function getWorkPattern(context: Pick<TriggerContext, 'redis'>): Promise<WorkPattern | undefined> {
  const raw = await context.redis.get(WORK_PATTERN_KEY);

  return raw ? workPattern.parse(JSON.parse(raw)) : undefined;
}

export function validateWorkPattern(pattern: WorkPattern): void {
  workPattern.parse(pattern);
}

export function isWorkThread(
  post: { title: string; authorName: string; createdAt: Date },
  pattern: WorkPattern,
): boolean {
  const title = post.title.toLowerCase();

  if (!title.startsWith(pattern.titlePrefix.toLowerCase()) ||
      !title.endsWith(pattern.titleSuffix.toLowerCase()) ||
      post.authorName.toLowerCase() !== pattern.author.toLowerCase()) return false;
  const fortnight = 14 * 24 * 60 * 60 * 1000;
  const delta = post.createdAt.getTime() - Date.parse(pattern.anchorUtc);
  const distance = Math.abs(delta - Math.round(delta / fortnight) * fortnight);

  return distance <= pattern.toleranceMinutes * 60 * 1000;
}

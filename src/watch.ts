import type { TriggerContext } from '@devvit/public-api';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assess, type Evidence } from './decisions.js';
import { diagnosticFailure, failureMetadata, failureReason } from './diagnostics.js';
import { RULE_VERSION, ruleLabel, rules, type RuleName } from './rules.js';
import { reportingRules } from './stats.js';
import { RETENTION_MS, saveAssessment, type Assessment } from './storage.js';
import { subredditName } from './subreddit.js';
import { isWorkThread } from './work-threads.js';

export function digest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

export function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export async function watch(kind: 'post' | 'comment', id: string, context: TriggerContext): Promise<void> {
  const approved = await context.settings.get<boolean>('processing-approved');
  console.log('[rule-watch] processing_gate', { kind, id, approved: approved === true });

  if (!approved) return;
  const lockKey = `processing:${id}`;

  const locked = await context.redis.set(lockKey, '1', {
    nx: true, expiration: new Date(Date.now() + 120_000),
  });

  if (locked !== 'OK') {
    console.log('[rule-watch] processing_lock_held', { id });

    return;
  }

  try {
    await evaluate(kind, id, context);
  } catch (error) {
    diagnosticFailure('evaluation_failed', failureMetadata.parse(error), failureReason.parse(error));
    throw new Error(`Rule Watch failed for ${id}`);
  } finally {
    await context.redis.del(lockKey);
  }
}

async function overDailyCap(now: number, context: TriggerContext): Promise<boolean> {
  const key = `report-count:${new Date(now).toISOString().slice(0, 10)}`;
  const count = await context.redis.incrBy(key, 1);
  await context.redis.expire(key, 2 * 24 * 60 * 60);

  return count > (await context.settings.get<number>('daily-report-cap') ?? 20);
}

function isGone(item: { removed: boolean; spam: boolean; body?: string | undefined }): boolean {
  return item.removed || item.spam || ['[deleted]', '[removed]'].includes(item.body ?? '');
}

async function evaluate(kind: 'post' | 'comment', id: string, context: TriggerContext): Promise<void> {
  const item = kind === 'post'
    ? await context.reddit.getPostById(id)
    : await context.reddit.getCommentById(id);

  if (item.subredditId !== context.subredditId) throw new Error('Wrong subreddit');

  if (isGone(item) || ['automoderator', context.appSlug.toLowerCase(), '[deleted]'].includes(item.authorName.toLowerCase())) {
    console.log('[rule-watch] excluded_content', { id });

    return;
  }

  const comment = 'parentId' in item ? item : undefined;
  const post = 'title' in item ? item : await context.reddit.getPostById(item.postId);
  const body = item.body ?? '';

  if (!normalize(`${kind === 'post' ? post.title : ''} ${body}`)) {
    console.log('[rule-watch] empty_content', { id });

    return;
  }

  const workTitle = (await context.settings.get<string>('work-thread-title'))?.trim() ?? '';
  const thresholds: Partial<Record<RuleName, number>> = {};

  for (const rule of rules) {
    const value = await context.settings.get<number>(`threshold-${rule.name}`) ?? 0.95;

    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid threshold');
    thresholds[rule.name] = value;
  }

  const configuration = `${RULE_VERSION}-${digest(JSON.stringify({ thresholds, workTitle })).slice(0, 16)}`;
  const contentDigest = digest(JSON.stringify({ title: kind === 'post' ? normalize(post.title) : '', body: normalize(body) }));
  const seenKey = `seen:${id}`;
  const revision = `${contentDigest}:${configuration}`;

  if (await context.redis.get(seenKey) === revision) {
    console.log('[rule-watch] revision_unchanged', { id });

    return;
  }

  const key = await context.settings.get<string>('openai-api-key');

  if (!key) throw new Error('OpenAI key is not configured');

  const evidence: Evidence = {
    target: { kind, body: body.slice(0, 12_000) },
    context: { parents: [], truncated: body.length > 12_000 || post.title.length > 500 },
    verifiedWorkThread: workTitle ? await isWorkThread(post, workTitle, context) : false,
  };

  if (kind === 'post') evidence.target.title = post.title.slice(0, 500);

  if (kind === 'comment') {
    const postBody = post.removed || post.spam ? '' : post.body ?? '';
    evidence.context.post = { title: post.title.slice(0, 500), body: postBody.slice(0, 6_000) };
    evidence.context.truncated ||= postBody.length > 6_000;
    let parentId = comment!.parentId;

    for (let depth = 0; depth < 3 && parentId.startsWith('t1_'); depth++) {
      try {
        const parent = await context.reddit.getCommentById(parentId);

        if (!isGone(parent)) {
          evidence.context.parents.unshift({ body: parent.body.slice(0, 3_000), author: parent.authorName });
          evidence.context.truncated ||= parent.body.length > 3_000;
        }

        parentId = parent.parentId;
      } catch {
        evidence.context.truncated = true;
        break;
      }
    }

    evidence.context.truncated ||= parentId.startsWith('t1_');
  }

  const scores = await assess(key, evidence, workTitle !== '');
  const flagged = rules.filter((rule) => (scores[rule.name] ?? -1) >= thresholds[rule.name]!).map((rule) => rule.name);
  const assessedAt = Date.now();

  const record: Assessment = {
    id: `${id}:${contentDigest.slice(0, 16)}:${configuration}`,
    contentId: id,
    kind,
    permalink: `https://www.reddit.com/r/${await subredditName(context)}/comments/${post.id.slice(3)}/${kind === 'comment' ? `_/${item.id.slice(3)}/` : ''}`,
    assessedAt,
    configuration,
    scores,
    flagged,
    delivery: 'none',
  };

  await saveAssessment(record, context);
  await context.redis.set(seenKey, revision, { expiration: new Date(assessedAt + RETENTION_MS) });
  console.log('[rule-watch] assessment_saved', { id, flaggedCount: flagged.length });
  const reporting = await reportingRules(context);
  const reportable = flagged.filter((name) => reporting.includes(name));

  if (!reportable.length) return;
  const current = kind === 'post' ? await context.reddit.getPostById(id) : await context.reddit.getCommentById(id);

  const currentDigest = digest(JSON.stringify({
    title: kind === 'post' && 'title' in current ? normalize(current.title) : '',
    body: normalize(current.body ?? ''),
  }));

  const claimed = currentDigest === contentDigest && !isGone(current) &&
    await context.redis.set(`reported:${id}`, '1', { nx: true, expiration: new Date(assessedAt + RETENTION_MS) }) === 'OK';

  try {
    if (!claimed) record.delivery = 'suppressed';
    else if (await overDailyCap(assessedAt, context)) record.delivery = 'capped';
    else {
      record.delivery = 'failed';
      await context.reddit.report(current, { reason: `Rule Watch: ${reportable.map(ruleLabel).join(', ')}`.slice(0, 100) });
      record.delivery = 'reported';
    }
  } finally {
    await saveAssessment(record, context);
    console.log('[rule-watch] report_delivery', { id, delivery: record.delivery });
  }
}

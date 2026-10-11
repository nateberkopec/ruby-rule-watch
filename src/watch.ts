import type { TriggerContext } from '@devvit/public-api';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assess, type Evidence } from './decisions.js';
import { diagnosticFailure, failureMetadata } from './diagnostics.js';
import { RULE_VERSION, ruleLabel, rules, type RuleName } from './rules.js';
import { RETENTION_MS, saveAssessment, type Assessment } from './storage.js';
import { getWorkPattern, isWorkThread } from './work-threads.js';

export const RECIPIENT = 'nateberkopec';

export const LIVE_KEY = 'live-alerts';

export function digest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

export function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export async function subredditName(context: Pick<TriggerContext, 'subredditName' | 'subredditId' | 'reddit'>): Promise<string> {
  const name = context.subredditName ?? (await context.reddit.getSubredditInfoById(context.subredditId)).name;

  if (!name) throw new Error('Subreddit name unavailable');

  return name;
}

export async function watch(kind: 'post' | 'comment', id: string, context: TriggerContext): Promise<void> {
  const approved = await context.settings.get<boolean>('processing-approved');
  console.log('[DEBUG-rule-watch] processing_gate', { kind, id, approved: approved === true });

  if (!approved) return;
  const lockKey = `processing:${id}`;

  const locked = await context.redis.set(lockKey, '1', {
    nx: true, expiration: new Date(Date.now() + 120_000),
  });

  if (locked !== 'OK') {
    console.log('[DEBUG-rule-watch] processing_lock_held', { id });

    return;
  }

  try {
    await evaluate(kind, id, context);
  } catch (error) {
    diagnosticFailure('evaluation_failed', failureMetadata.parse(error));
    console.error(`Rule Watch failed for ${id}`);
    throw new Error(`Rule Watch failed for ${id}`);
  } finally {
    await context.redis.del(lockKey);
  }
}

async function evaluate(kind: 'post' | 'comment', id: string, context: TriggerContext): Promise<void> {
  const item = kind === 'post'
    ? await context.reddit.getPostById(id)
    : await context.reddit.getCommentById(id);

  if (item.subredditId !== context.subredditId) throw new Error('Wrong subreddit');

  if (item.removed || item.spam || ['[deleted]', '[removed]'].includes(item.body ?? '') ||
      ['automoderator', context.appSlug.toLowerCase(), '[deleted]'].includes(item.authorName.toLowerCase())) {
    console.log('[DEBUG-rule-watch] excluded_content', { id });

    return;
  }

  const comment = 'parentId' in item ? item : undefined;
  const post = 'title' in item ? item : await context.reddit.getPostById(item.postId);
  const body = item.body ?? '';

  if (!normalize(`${kind === 'post' ? post.title : ''} ${body}`)) {
    console.log('[DEBUG-rule-watch] empty_content', { id });

    return;
  }

  const pattern = await getWorkPattern(context);
  const thresholds: Partial<Record<RuleName, number>> = {};

  for (const rule of rules) {
    const value = await context.settings.get<number>(`threshold-${rule.name}`) ?? 0.95;

    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid threshold');
    thresholds[rule.name] = value;
  }

  const configuration = `${RULE_VERSION}-${digest(JSON.stringify({ thresholds, pattern })).slice(0, 16)}`;
  const contentDigest = digest(JSON.stringify({ title: kind === 'post' ? normalize(post.title) : '', body: normalize(body) }));
  const seenKey = `seen:${id}`;
  const revision = `${contentDigest}:${configuration}`;

  if (await context.redis.get(seenKey) === revision) {
    console.log('[DEBUG-rule-watch] revision_unchanged', { id });

    return;
  }

  const key = await context.settings.get<string>('openai-api-key');
  console.log('[DEBUG-rule-watch] key_available', { id, present: Boolean(key) });

  if (!key) throw new Error('OpenAI key is not configured');

  const evidence: Evidence = {
    target: { kind, body: body.slice(0, 12_000) },
    context: { parents: [], truncated: body.length > 12_000 || post.title.length > 500 },
    verifiedWorkThread: pattern ? isWorkThread(post, pattern) : false,
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

        if (!parent.removed && !parent.spam && !['[deleted]', '[removed]'].includes(parent.body)) {
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

  const scores = await assess(key, evidence, pattern !== undefined);
  const flagged = rules.filter((rule) => (scores[rule.name] ?? -1) >= thresholds[rule.name]!).map((rule) => rule.name);
  const assessedAt = Date.now();

  const record: Assessment = {
    id: `${id}:${contentDigest.slice(0, 16)}:${configuration}`,
    contentId: id,
    kind,
    permalink: `https://www.reddit.com/r/${await subredditName(context)}/comments/${post.id.slice(3)}/${kind === 'comment' ? `_/${item.id.slice(3)}/` : ''}`,
    assessedAt,
    configuration,
    mode: await context.redis.get(LIVE_KEY) === 'true' ? 'live' : 'shadow',
    scores,
    flagged,
    delivery: 'none',
  };

  await saveAssessment(record, context);
  await context.redis.set(seenKey, revision, { expiration: new Date(assessedAt + RETENTION_MS) });
  console.log('[DEBUG-rule-watch] assessment_saved', { id, mode: record.mode, flaggedCount: flagged.length });

  if (record.mode !== 'live' || !flagged.length) return;
  const current = kind === 'post' ? await context.reddit.getPostById(id) : await context.reddit.getCommentById(id);

  const currentDigest = digest(JSON.stringify({
    title: kind === 'post' && 'title' in current ? normalize(current.title) : '',
    body: normalize(current.body ?? ''),
  }));

  if (currentDigest !== contentDigest || current.removed || current.spam ||
      ['[deleted]', '[removed]'].includes(current.body ?? '')) {
    record.delivery = 'suppressed';
    await saveAssessment(record, context);

    return;
  }

  const notifiedKey = `notified:${id}`;

  const claimed = await context.redis.set(notifiedKey, 'attempted', {
    nx: true, expiration: new Date(assessedAt + RETENTION_MS),
  });

  if (claimed !== 'OK') {
    record.delivery = 'suppressed';
    await saveAssessment(record, context);

    return;
  }

  record.delivery = 'attempted';
  await saveAssessment(record, context);

  try {
    await context.reddit.sendPrivateMessage({
      to: RECIPIENT,
      subject: `Rule Watch: possible ${flagged.map(ruleLabel).join(', ')}`.slice(0, 100),
      text: `Possible rule violation; please review, not an automatic moderation decision.\n\nRules: ${flagged.map(ruleLabel).join(', ')}\n\n${record.permalink}\n\nOriginal content excerpt:\n\n${(kind === 'post' ? `${post.title}\n${body}` : body).slice(0, 800).split('\n').map((line) => `> ${line.replace(/[[\]()*_<>\\]/g, '\\$&')}`).join('\n')}\n\nAssessment: \`${record.id}\``,
    });
    record.delivery = 'sent';
  } catch {
    record.delivery = 'failed';
    throw new Error('Reddit alert delivery failed');
  } finally {
    await saveAssessment(record, context);
  }
}

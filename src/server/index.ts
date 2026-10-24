import type { IncomingMessage, ServerResponse } from 'node:http';
import { context, createServer, getServerPort, reddit, redis, scheduler } from '@devvit/web/server';
import { z } from 'zod';
import {
  BACKTEST_RETENTION_MS, CORPUS_SIZE, corpusComplete, corpusItems, keys, kickBacktest,
  liveWording, readCorpus, readQueue, readRewrites, readScores, ruleName, saveQueue,
  saveRewrites, wordingId,
} from '../backtest-store.js';
import { diagnosticFailure, failureDisplay, failureReason } from '../diagnostics.js';
import { evaluationInstructions, rules } from '../rules.js';

const judgment = z.object({ rule: ruleName, id: z.string(), verdict: z.enum(['yes', 'no']).nullable() });

const rewriteRequest = z.object({ rule: ruleName, text: z.string().trim().min(1).max(4000) });

const textRequest = z.object({ ids: z.array(z.string().regex(/^t[13]_\w+$/)).max(50) });

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function requireModerator(): Promise<void> {
  const { username, subredditName } = context;

  if (!username || !subredditName) throw new HttpError(403, 'Moderators only');
  const moderators = await reddit.getModerators({ subredditName, username }).all();

  if (!moderators.some((moderator) => moderator.username.toLowerCase() === username.toLowerCase())) throw new HttpError(403, 'Moderators only');
}

async function body<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  let text = '';

  for await (const chunk of req) text += chunk;

  return schema.parse(JSON.parse(text || '{}'));
}

function isPostId(id: string): id is `t3_${string}` {
  return id.startsWith('t3_');
}

function isCommentId(id: string): id is `t1_${string}` {
  return id.startsWith('t1_');
}

async function state() {
  const corpus = await readCorpus(redis);
  const ids = corpus ? corpusItems(corpus) : [];
  const live = Object.fromEntries(rules.map((rule) => [rule.name, liveWording(rule.name)]));
  const firstLive = live[rules[0].name]!.id;
  let queue = await readQueue(redis);
  const liveScores = await readScores(firstLive, redis);

  if ((!corpus || !corpusComplete(corpus) || ids.some((id) => !(id in liveScores))) && !queue.some((task) => !task.rule)) {
    queue = [{ wordingId: firstLive }, ...queue];
    await saveQueue(queue, redis);
  }

  await kickBacktest(redis, scheduler);
  const wordings = [];
  const scores: Record<string, Record<string, number>> = {};

  for (const rule of rules) {
    const versions = [{ ...live[rule.name]!, live: true }, ...(await readRewrites(rule.name, redis)).map((entry) => ({ ...entry, live: false }))];
    wordings.push({ name: rule.name, label: rule.label, versions });

    for (const version of versions) scores[version.id] = await readScores(version.id, redis);
  }

  const total = corpus && corpusComplete(corpus) ? ids.length : CORPUS_SIZE;

  const judgments = Object.fromEntries(Object.entries(await redis.hGetAll(keys.judgments)).flatMap(([key, value]) => {
    const [verdict, at] = value.split(':');

    return Number(at) > Date.now() - BACKTEST_RETENTION_MS ? [[key, verdict]] : [];
  }));

  return {
    items: ids.map((id) => ({ id })),
    rules: wordings,
    shared: evaluationInstructions,
    scores,
    judgments,
    queue: queue.map((task) => ({
      rule: task.rule ?? null, wordingId: task.wordingId, total,
      done: ids.filter((id) => id in (scores[task.wordingId] ?? {})).length,
    })),
    error: await redis.get(keys.error) ?? null,
  };
}

async function judge({ rule, id, verdict }: z.infer<typeof judgment>) {
  if (verdict) await redis.hSet(keys.judgments, { [`${rule}:${id}`]: `${verdict}:${Date.now()}` });
  else await redis.hDel(keys.judgments, [`${rule}:${id}`]);
  await redis.expire(keys.judgments, BACKTEST_RETENTION_MS / 1000);

  return { ok: true };
}

async function rewrite({ rule, text }: z.infer<typeof rewriteRequest>) {
  const corpus = await readCorpus(redis);

  if (!corpus || !corpusComplete(corpus)) throw new HttpError(409, 'Wait for the live wording to finish scoring.');
  const id = wordingId(rule, text);

  if (id === liveWording(rule).id) return { wordingId: id };
  const rewrites = await readRewrites(rule, redis);

  if (!rewrites.some((entry) => entry.id === id)) await saveRewrites(rule, [...rewrites, { id, text }], redis);
  const queue = await readQueue(redis);

  if (!queue.some((task) => task.wordingId === id)) await saveQueue([...queue, { rule, wordingId: id }], redis);
  await kickBacktest(redis, scheduler);

  return { wordingId: id };
}

function permalink(path: string): string {
  return `https://www.reddit.com${path}`;
}

async function liveText(id: string) {
  if (isPostId(id)) {
    const post = await reddit.getPostById(id);

    return { id, kind: 'post', author: post.authorName, title: post.title, body: post.body ?? '', permalink: permalink(post.permalink) };
  }

  if (!isCommentId(id)) throw new Error('Unknown item');
  const comment = await reddit.getCommentById(id);
  const parentId: string = comment.parentId;

  const parent = isCommentId(parentId)
    ? (await reddit.getCommentById(parentId)).body
    : (await reddit.getPostById(comment.postId)).title;

  return { id, kind: 'comment', author: comment.authorName, body: comment.body, parent, permalink: permalink(comment.permalink) };
}

async function text({ ids }: z.infer<typeof textRequest>) {
  return Promise.all(ids.map(async (id) => {
    try {
      return await liveText(id);
    } catch {
      return { id, unavailable: true };
    }
  }));
}

function send<T>(res: ServerResponse, status: number, payload: T): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  await requireModerator();

  if (req.method === 'GET' && path === '/api/state') return send(res, 200, await state());

  if (req.method === 'POST' && path === '/api/judge') return send(res, 200, await judge(await body(req, judgment)));

  if (req.method === 'POST' && path === '/api/rewrite') return send(res, 200, await rewrite(await body(req, rewriteRequest)));

  if (req.method === 'POST' && path === '/api/text') return send(res, 200, await text(await body(req, textRequest)));
  send(res, 404, { error: 'Not found' });
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
    diagnosticFailure('backtest_request_failed', { status }, failureReason.parse(error));
    send(res, status, { error: failureDisplay.parse(error) });
  });
}).listen(getServerPort());

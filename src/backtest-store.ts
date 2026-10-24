import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { evaluationInstructions, rules, type RuleName } from './rules.js';

export const SOURCE_SUBREDDIT = 'ruby';

export const BACKTEST_JOB = 'backtest';

export const CORPUS_SIZE = 1000;

export const BACKTEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const ruleName = z.enum(rules.map((rule) => rule.name));

export const corpus = z.object({
  createdAt: z.number(),
  posts: z.array(z.string()),
  cursor: z.number(),
  groups: z.array(z.object({ post: z.string(), items: z.array(z.string()) })),
});

export type Corpus = z.infer<typeof corpus>;

export const task = z.object({ rule: ruleName.optional(), wordingId: z.string() });

export type Task = z.infer<typeof task>;

const wording = z.object({ id: z.string(), text: z.string() });

export type Wording = z.infer<typeof wording>;

export const keys = {
  corpus: 'backtest:corpus',
  queue: 'backtest:queue',
  running: 'backtest:running',
  next: 'backtest:next',
  error: 'backtest:error',
  post: 'backtest:post',
  judgments: 'backtest:judgments',
  wordings: (rule: RuleName) => `backtest:wordings:${rule}`,
  scores: (wordingId: string) => `backtest:scores:${wordingId}`,
};

type Store = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: { nx?: boolean; expiration?: Date }): Promise<string>;
  hGetAll(key: string): Promise<Record<string, string>>;
};

type Scheduler = { runJob(job: { name: string; runAt: Date }): Promise<string> };

export async function kickBacktest(store: Store, scheduler: Scheduler): Promise<void> {
  if (!(await readQueue(store)).length || await store.get(keys.running) || await store.get(keys.next)) return;
  await store.set(keys.next, '1', { expiration: new Date(Date.now() + 90_000) });
  await scheduler.runJob({ name: BACKTEST_JOB, runAt: new Date() });
}

export function wordingId(rule: RuleName, text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(['gpt-6-luna', evaluationInstructions, rule, text])))).slice(0, 16);
}

export function liveWording(rule: RuleName): Wording {
  const text = rules.find((entry) => entry.name === rule)!.instructions;

  return { id: wordingId(rule, text), text };
}

export function expiresAt(createdAt: number): Date {
  return new Date(createdAt + BACKTEST_RETENTION_MS);
}

export function corpusItems(value: Corpus): string[] {
  return value.groups.flatMap((group) => group.items);
}

export function corpusComplete(value: Corpus): boolean {
  return corpusItems(value).length >= CORPUS_SIZE || value.cursor >= value.posts.length;
}

export async function readCorpus(store: Store): Promise<Corpus | undefined> {
  const raw = await store.get(keys.corpus);

  return raw ? corpus.parse(JSON.parse(raw)) : undefined;
}

export async function saveCorpus(value: Corpus, store: Store): Promise<void> {
  await store.set(keys.corpus, JSON.stringify(value), { expiration: expiresAt(value.createdAt) });
}

export async function readQueue(store: Store): Promise<Task[]> {
  return z.array(task).parse(JSON.parse(await store.get(keys.queue) ?? '[]'));
}

export async function saveQueue(queue: Task[], store: Store): Promise<void> {
  await store.set(keys.queue, JSON.stringify(queue), { expiration: expiresAt(Date.now()) });
}

export async function readRewrites(rule: RuleName, store: Store): Promise<Wording[]> {
  return z.array(wording).parse(JSON.parse(await store.get(keys.wordings(rule)) ?? '[]'));
}

export async function saveRewrites(rule: RuleName, rewrites: Wording[], store: Store): Promise<void> {
  await store.set(keys.wordings(rule), JSON.stringify(rewrites), { expiration: expiresAt(Date.now()) });
}

export async function readScores(id: string, store: Store): Promise<Record<string, number>> {
  const raw = await store.hGetAll(keys.scores(id));

  return Object.fromEntries(Object.entries(raw).map(([item, value]) => [item, value === 'failed' ? -1 : Number(value)]));
}

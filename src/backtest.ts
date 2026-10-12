import type { Comment, Listing, Post, TriggerContext } from '@devvit/public-api';
import {
  CORPUS_SIZE, SOURCE_SUBREDDIT, corpusComplete, corpusItems, expiresAt, keys, kickBacktest, liveWording,
  readCorpus, readQueue, readRewrites, removedItems, saveCorpus, saveQueue, type Corpus, type Task,
} from './backtest-store.js';
import { assess, type Evidence } from './decisions.js';
import { diagnosticFailure, failureDisplay, failureMetadata, failureReason } from './diagnostics.js';
import { buildEvidence, isExcludedAuthor, isGone } from './evidence.js';
import { evaluationInstructions, rules } from './rules.js';
import { normalize } from './watch.js';
import { DEFAULT_WORK_TITLE } from './work-threads.js';

const CONCURRENCY = 8;

type Question = { name: string; instructions: string; wordingId: string };

type Thread = { post: Post; comments: Map<string, Comment> };

export async function backtestTick(context: TriggerContext): Promise<void> {
  if (await context.redis.set(keys.running, '1', { nx: true, expiration: new Date(Date.now() + 60_000) }) !== 'OK') return;
  await context.redis.del(keys.next);
  let failed = false;

  try {
    await work(context, Date.now() + 18_000);
    await context.redis.del(keys.error);
  } catch (error) {
    failed = true;
    diagnosticFailure('backtest_failed', failureMetadata.parse(error), failureReason.parse(error));
    await context.redis.set(keys.error, failureDisplay.parse(error), { expiration: new Date(Date.now() + 86_400_000) });
  } finally {
    await context.redis.del(keys.running);
  }

  if (!failed) await kickBacktest(context.redis, context.scheduler);
}

async function questionsFor(task: Task, context: TriggerContext): Promise<Question[]> {
  if (!task.rule) {
    return rules.map((rule) => ({
      name: rule.name, instructions: `${evaluationInstructions} ${rule.instructions}`, wordingId: liveWording(rule.name).id,
    }));
  }

  const wording = (await readRewrites(task.rule, context.redis)).find((entry) => entry.id === task.wordingId);

  if (!wording) throw new Error('Rewrite not found');

  return [{ name: task.rule, instructions: `${evaluationInstructions} ${wording.text}`, wordingId: wording.id }];
}

async function work(context: TriggerContext, deadline: number): Promise<void> {
  const queue = await readQueue(context.redis);
  const task = queue[0];

  if (!task) return;
  const apiKey = await context.settings.get<string>('openai-api-key');

  if (!apiKey) throw new Error('OpenAI key is not configured');
  const questions = await questionsFor(task, context);
  const corpus = await readCorpus(context.redis);

  if (!corpus) {
    const posts = await context.reddit.getNewPosts({ subredditName: SOURCE_SUBREDDIT, limit: 600, pageSize: 100 }).all();
    await saveCorpus({ createdAt: Date.now(), posts: posts.map((post) => post.id), cursor: 0, groups: [] }, context.redis);
    console.log('[rule-watch] backtest_posts_listed', { count: posts.length });

    return;
  }

  const scored = new Set(Object.keys(await context.redis.hGetAll(keys.scores(questions[0]!.wordingId))));
  const score = scorer(apiKey, questions, corpus, context);
  const workThread = workThreadCheck(context);

  for (const group of corpus.groups) {
    const unscored = group.items.filter((id) => !scored.has(id));

    if (!unscored.length) continue;

    if (Date.now() > deadline) return;
    const thread = await fetchThread(group.post, context);
    const verified = await workThread(thread.post);
    await pool(unscored, deadline, (id) => threadEvidence(id, thread, verified, context).then((evidence) => score(id, evidence)));
  }

  while (!corpusComplete(corpus)) {
    if (Date.now() > deadline) return;
    const thread = await fetchThread(corpus.posts[corpus.cursor]!, context);
    const room = CORPUS_SIZE - corpusItems(corpus).length;
    const items = [thread.post, ...thread.comments.values()].filter((item) => eligible(item, context.appSlug)).slice(0, room).map((item) => item.id);
    corpus.groups.push({ post: thread.post.id, items });
    corpus.cursor++;
    await saveCorpus(corpus, context.redis);
    const verified = await workThread(thread.post);
    await pool(items, deadline, (id) => threadEvidence(id, thread, verified, context).then((evidence) => score(id, evidence)));
  }

  const removed = (await removedItems(context.redis.global)).filter((item) => !scored.has(item.id));
  await pool(removed, deadline, (item) => score(item.id, item.evidence));

  if (Date.now() > deadline) return;
  const remaining = new Set(Object.keys(await context.redis.hGetAll(keys.scores(questions[0]!.wordingId))));

  if (corpusItems(corpus).some((id) => !remaining.has(id)) || removed.some((item) => !remaining.has(item.id))) return;
  await saveQueue(queue.slice(1), context.redis);
  console.log('[rule-watch] backtest_task_done', { wordingId: task.wordingId, live: !task.rule });
}

function scorer(apiKey: string, questions: Question[], corpus: Corpus, context: TriggerContext) {
  return async (id: string, evidence: Evidence): Promise<void> => {
    let values: Record<string, string>;

    try {
      const scores = await assess(apiKey, evidence, questions.map(({ name, instructions }) => ({ name, instructions })));
      values = Object.fromEntries(questions.map((question) => [question.wordingId, String(scores[question.name])]));
    } catch (error) {
      diagnosticFailure('backtest_item_failed', failureMetadata.parse(error), failureReason.parse(error));
      values = Object.fromEntries(questions.map((question) => [question.wordingId, 'failed']));
    }

    for (const [wordingId, value] of Object.entries(values)) {
      await context.redis.hSet(keys.scores(wordingId), { [id]: value });
      await context.redis.expire(keys.scores(wordingId), Math.floor((expiresAt(corpus.createdAt).getTime() - Date.now()) / 1000));
    }
  };
}

async function pool<T>(items: T[], deadline: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && Date.now() < deadline) await run(queue.shift()!);
  }));
}

function eligible(item: Post | Comment, appSlug: string): boolean {
  const text = 'parentId' in item ? item.body : `${item.title} ${item.body ?? ''}`;

  return !isGone(item) && !isExcludedAuthor(item.authorName, appSlug) && normalize(text) !== '';
}

async function fetchThread(postId: string, context: TriggerContext): Promise<Thread> {
  const post = await context.reddit.getPostById(postId);
  const comments = new Map<string, Comment>();

  const walk = async (listing: Listing<Comment>): Promise<void> => {
    for (const comment of await listing.all()) {
      comments.set(comment.id, comment);
      await walk(comment.replies);
    }
  };

  await walk(context.reddit.getComments({ postId: post.id, limit: 1000, pageSize: 100 }));

  return { post, comments };
}

async function threadEvidence(id: string, thread: Thread, verified: boolean, context: TriggerContext): Promise<Evidence> {
  const item = id === thread.post.id ? thread.post : thread.comments.get(id) ?? await context.reddit.getCommentById(id);

  return buildEvidence(item, thread.post, verified, async (parentId) => thread.comments.get(parentId) ?? context.reddit.getCommentById(parentId));
}

function workThreadCheck(context: TriggerContext): (post: Post) => Promise<boolean> {
  let moderators: Promise<Set<string>> | undefined;

  return async (post) => {
    if (post.title.trim().toLowerCase() !== DEFAULT_WORK_TITLE.toLowerCase()) return false;

    if (post.authorName.toLowerCase() === 'automoderator') return true;

    moderators ??= context.reddit.getModerators({ subredditName: SOURCE_SUBREDDIT }).all()
      .then((users) => new Set(users.map((user) => user.username.toLowerCase())))
      .catch(() => new Set());

    return (await moderators).has(post.authorName.toLowerCase());
  };
}

import type { TriggerContext } from '@devvit/public-api';
import { isModerator, subredditName } from './subreddit.js';

export const DEFAULT_WORK_TITLE = 'Work it Wednesday: Who is hiring? Who is looking?';

type WorkContext = Pick<TriggerContext, 'subredditName' | 'subredditId' | 'reddit'>;

export async function isWorkThread(
  post: { title: string; authorName: string },
  title: string,
  context: WorkContext,
): Promise<boolean> {
  if (post.title.trim().toLowerCase() !== title.trim().toLowerCase()) return false;

  return post.authorName.toLowerCase() === 'automoderator' || isModerator(post.authorName, context);
}

export async function validateWorkTitle(title: string | undefined, context: WorkContext): Promise<string | undefined> {
  if (!title?.trim()) return;

  const posts = await context.reddit.searchPosts({
    subredditName: await subredditName(context), query: `title:"${title.trim()}"`, sort: 'new', timeframe: 'all', limit: 25,
  }).all();

  let matches = 0;

  for (const post of posts) if (await isWorkThread(post, title, context)) matches++;

  if (matches < 3) {
    return `Found ${matches} past posts by AutoModerator or a moderator with exactly this title; at least 3 are required.`;
  }
}

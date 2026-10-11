import type { TriggerContext } from '@devvit/public-api';

type SubredditContext = Pick<TriggerContext, 'subredditName' | 'subredditId' | 'reddit'>;

export async function subredditName(context: SubredditContext): Promise<string> {
  const name = context.subredditName ?? (await context.reddit.getSubredditInfoById(context.subredditId)).name;

  if (!name) throw new Error('Subreddit name unavailable');

  return name;
}

export async function isModerator(username: string, context: SubredditContext): Promise<boolean> {
  const moderators = await context.reddit.getModerators({ subredditName: await subredditName(context), username }).all();

  return moderators.some((moderator) => moderator.username.toLowerCase() === username.toLowerCase());
}

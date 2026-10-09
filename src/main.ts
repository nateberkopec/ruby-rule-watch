import { Devvit, type Context, type MenuItemOnPressEvent } from '@devvit/public-api';
import { ruleLabel, rules } from './rules.js';
import { cleanup, getAssessment, recentAssessments, saveAssessment } from './storage.js';
import { LIVE_KEY, RECIPIENT, subredditName, watch } from './watch.js';
import { getWorkPattern, isWorkThread, validateWorkPattern, WORK_PATTERN_KEY, type WorkPattern } from './work-threads.js';

Devvit.configure({ redditAPI: true, redis: true, http: { domains: ['api.openai.com'] } });

Devvit.addSettings([
  { type: 'string', name: 'openai-api-key', label: 'OpenAI API key', scope: 'app', isSecret: true },
  {
    type: 'boolean', name: 'processing-approved', label: 'Mod team approved sending content to OpenAI',
    defaultValue: false,
    helpText: 'Off means no content processing. Approval is required even in shadow mode.',
  },
  ...rules.map((rule) => ({
    type: 'number' as const,
    name: `threshold-${rule.name}`,
    label: `${rule.label}: alert threshold`,
    defaultValue: 0.95,
    helpText: 'Provisional model-estimate threshold, not a measured precision guarantee.',
    onValidate: ({ value }: { value: number | undefined }) =>
      value === undefined || !Number.isFinite(value) || value < 0 || value > 1 ? 'Enter a number from 0 to 1.' : undefined,
  })),
]);

async function requireModerator(context: Context): Promise<void> {
  if (!context.userId) throw new Error('Login required');
  const user = await context.reddit.getUserById(context.userId);

  if (!user) throw new Error('User not found');

  const moderators = await context.reddit.getModerators({
    subredditName: await subredditName(context), username: user.username,
  }).all();

  if (!moderators.some((moderator) => moderator.username.toLowerCase() === user.username.toLowerCase())) {
    throw new Error('Moderator access required');
  }
}

function addMenu(label: string, location: 'subreddit' | ['post', 'comment'],
  handler: (event: MenuItemOnPressEvent, context: Context) => Promise<void>): void {
  Devvit.addMenuItem({
    label, location, forUserType: 'moderator',
    onPress: async (event, context) => {
      try {
        await requireModerator(context);
        await handler(event, context);
      } catch (error) {
        context.ui.showToast(error instanceof Error ? error.message : 'Action failed');
      }
    },
  });
}

Devvit.addTrigger({
  events: ['PostSubmit', 'PostCreate', 'PostUpdate', 'CommentSubmit', 'CommentCreate', 'CommentUpdate'],
  onEvent: async (event, context) => {
    if (event.type.startsWith('Comment')) {
      if ('comment' in event && event.comment?.id) {
        const id = event.comment.id.startsWith('t1_') ? event.comment.id : `t1_${event.comment.id}`;
        await watch('comment', id, context);
      }
    } else if (event.post?.id) {
      const id = event.post.id.startsWith('t3_') ? event.post.id : `t3_${event.post.id}`;
      await watch('post', id, context);
    }
  },
});

Devvit.addSchedulerJob({ name: 'expire-assessment-index', onRun: async (_event, context) => cleanup(context) });

Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: async (_event, context) => {
    const jobs = await context.scheduler.listJobs();

    if (!jobs.some((job) => job.name === 'expire-assessment-index')) {
      await context.scheduler.runJob({ name: 'expire-assessment-index', cron: '0 0 * * *' });
    }
  },
});

const modeForm = Devvit.createForm({
  title: 'Rule Watch delivery mode',
  description: 'Shadow records assessments without automatic messages. Live affects future assessments; it does not send a backlog.',
  fields: [
    { type: 'boolean', name: 'live', label: 'Enable live alerts', defaultValue: false },
    { type: 'boolean', name: 'receivedTest', label: 'nateberkopec received the private-message test', defaultValue: false },
  ],
}, async ({ values }, context) => {
  await requireModerator(context);

  if (values.live) {
    if (!(await context.settings.get<boolean>('processing-approved'))) throw new Error('Mod-team processing approval is required.');

    if (!(await context.settings.get<string>('openai-api-key'))) throw new Error('Configure the OpenAI API key first.');

    if (!values.receivedTest || !(await context.redis.get('pm-test-sent'))) throw new Error('Send and confirm receipt of the PM test first.');
  }

  await context.redis.set(LIVE_KEY, values.live ? 'true' : 'false');
  context.ui.showToast(values.live ? 'Live alerts enabled.' : 'Shadow mode enabled.');
});

addMenu('Rule Watch: delivery mode', 'subreddit', async (_event, context) => context.ui.showForm(modeForm));

addMenu('Rule Watch: test private message', 'subreddit', async (_event, context) => {
  await context.reddit.sendPrivateMessage({
    to: RECIPIENT, subject: 'Rule Watch delivery test',
    text: 'This is a manually requested delivery test. No Reddit content was sent to OpenAI. Confirm receipt before enabling live alerts.',
  });
  await context.redis.set('pm-test-sent', new Date().toISOString());
  context.ui.showToast('Test submitted to Reddit. Confirm inbox receipt separately.');
});

addMenu('Rule Watch: request review report', 'subreddit', async (_event, context) => {
  const records = await recentAssessments(context);
  const flagged = records.filter((record) => record.flagged.length > 0);
  const clean = records.filter((record) => record.flagged.length === 0);
  const sample = [];
  const candidates = [...clean];

  while (sample.length < 5 && candidates.length) {
    sample.push(candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0]!);
  }

  const lines = [...flagged.slice(0, 20), ...sample].map((record) =>
    `- ${record.flagged.length ? record.flagged.map(ruleLabel).join(', ') : 'Unflagged sample'} | ${record.mode} | ${record.delivery} | feedback: ${record.feedback ?? 'unreviewed'}\n  ${record.permalink}\n  Assessment: \`${record.id}\``,
  );

  const reviewed = flagged.filter((record) => record.feedback);
  const useful = reviewed.filter((record) => record.feedback === 'useful').length;
  const pattern = await getWorkPattern(context);
  await context.reddit.sendPrivateMessage({
    to: RECIPIENT, subject: 'Rule Watch review report',
    text: `Manually requested report; no content excerpts.\n\nMode: ${await context.redis.get(LIVE_KEY) === 'true' ? 'live' : 'shadow'}. Work rule: ${pattern ? 'enabled with confirmed pattern' : 'DISABLED pending pattern verification'}.\n\nLatest ${records.length} assessments (at most 200, retained 30 days). Reviewed flags: ${useful}/${reviewed.length} useful. This is not a statistical guarantee. Up to 20 recent flags plus 5 unflagged samples follow.\n\n${lines.join('\n\n') || 'No assessments yet.'}\n\nUse the moderator feedback menu and paste the assessment ID to record useful/not useful. Unflagged samples can be marked not useful if a violation was missed; they are excluded from the flag-usefulness count.`,
  });
  context.ui.showToast('Review report submitted to Reddit.');
});

const feedbackForm = Devvit.createForm({
  title: 'Rule Watch assessment feedback',
  fields: [
    { type: 'string', name: 'assessmentId', label: 'Assessment ID from report or alert', required: true },
    {
      type: 'select', name: 'feedback', label: 'Was this assessment useful?', required: true,
      options: [{ label: 'Useful', value: 'useful' }, { label: 'Not useful / missed violation', value: 'not_useful' }],
    },
  ],
}, async ({ values }, context) => {
  await requireModerator(context);
  const id = values.assessmentId.trim();

  if (!/^t[13]_[a-z0-9]+:[a-f0-9]{16}:\d+-[a-f0-9]{16}$/.test(id)) throw new Error('Invalid assessment ID.');
  const record = await getAssessment(id, context);

  if (!record) throw new Error('Assessment not found or expired.');
  const feedback = values.feedback[0];

  if (feedback !== 'useful' && feedback !== 'not_useful') throw new Error('Choose a feedback value.');
  record.feedback = feedback;
  await saveAssessment(record, context);
  context.ui.showToast('Feedback saved.');
});

addMenu('Rule Watch: record feedback', 'subreddit', async (_event, context) => context.ui.showForm(feedbackForm));

addMenu('Rule Watch: inspect work-thread history', 'subreddit', async (_event, context) => {
  const posts = await context.reddit.searchPosts({
    subredditName: await subredditName(context), query: 'title:work', sort: 'new', timeframe: 'all', limit: 20,
  }).all();

  const lines = posts.map((post) =>
    `- ${post.title.replace(/[\r\n]/g, ' ').slice(0, 200)}\n  Author: ${post.authorName}; created UTC: ${post.createdAt.toISOString()}; ID: ${post.id}\n  https://www.reddit.com/r/${post.subredditName}/comments/${post.id.slice(3)}/`,
  );

  await context.reddit.sendPrivateMessage({
    to: RECIPIENT, subject: 'Rule Watch work-thread candidates',
    text: `These are search candidates, NOT automatically authorized threads. Verify actual scheduled posts before configuring a pattern. Title/author/date metadata is included in this private message.\n\n${lines.join('\n\n') || 'No candidates found; use known historical scheduled posts.'}`,
  });
  context.ui.showToast('Candidate metadata report submitted to Reddit.');
});

const workForm = Devvit.createForm({
  title: 'Confirm observed work-thread pattern',
  description: 'Only configure after inspecting actual scheduled posts. All three samples must match the trusted author, title and fortnightly UTC schedule. Any matching historical thread qualifies.',
  fields: [
    { type: 'string', name: 'titlePrefix', label: 'Observed title prefix', required: true },
    { type: 'string', name: 'titleSuffix', label: 'Observed title suffix (optional)' },
    { type: 'string', name: 'author', label: 'Scheduled-thread author username', required: true },
    { type: 'string', name: 'anchorUtc', label: 'Verified scheduled UTC time: YYYY-MM-DDTHH:MM:SSZ', required: true },
    { type: 'number', name: 'toleranceMinutes', label: 'Allowed schedule deviation in minutes (0–60)', defaultValue: 5, required: true },
    { type: 'string', name: 'sample1', label: 'First verified historical post ID (t3_...)', required: true },
    { type: 'string', name: 'sample2', label: 'Second verified historical post ID (t3_...)', required: true },
    { type: 'string', name: 'sample3', label: 'Third verified historical post ID (t3_...)', required: true },
    { type: 'boolean', name: 'confirmed', label: 'I verified these are moderator-authorized scheduled work threads', defaultValue: false },
  ],
}, async ({ values }, context) => {
  await requireModerator(context);

  if (!values.confirmed) throw new Error('Confirm moderator authorization first.');

  const pattern: WorkPattern = {
    titlePrefix: values.titlePrefix.trim(), titleSuffix: (values.titleSuffix ?? '').trim(),
    author: values.author.trim(), anchorUtc: values.anchorUtc.trim(), toleranceMinutes: values.toleranceMinutes,
  };

  validateWorkPattern(pattern);
  const sampleIds = [values.sample1, values.sample2, values.sample3].map((id) => id.trim());

  if (new Set(sampleIds).size !== 3 || sampleIds.some((id) => !/^t3_[a-z0-9]+$/.test(id))) {
    throw new Error('Provide three distinct full post IDs.');
  }

  for (const id of sampleIds) {
    const post = await context.reddit.getPostById(id);

    if (post.subredditId !== context.subredditId || !isWorkThread(post, pattern)) {
      throw new Error(`Sample ${id} does not match this subreddit/pattern.`);
    }
  }

  const mods = await context.reddit.getModerators({
    subredditName: await subredditName(context), username: pattern.author,
  }).all();

  if (!mods.some((mod) => mod.username.toLowerCase() === pattern.author.toLowerCase())) {
    throw new Error('The scheduled-thread author must be a current subreddit moderator.');
  }

  await context.redis.set(WORK_PATTERN_KEY, JSON.stringify(pattern));
  context.ui.showToast('Pattern confirmed; work-rule assessment enabled for future content.');
});

addMenu('Rule Watch: confirm work-thread pattern', 'subreddit', async (_event, context) => context.ui.showForm(workForm));

addMenu('Rule Watch: disable work-rule assessment', 'subreddit', async (_event, context) => {
  await context.redis.del(WORK_PATTERN_KEY);
  context.ui.showToast('Work-rule assessment disabled.');
});

export default Devvit;

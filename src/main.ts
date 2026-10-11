import { Devvit, type Context } from '@devvit/public-api';
import { z } from 'zod';
import { rules } from './rules.js';
import { diagnosticFailure, failureDisplay, failureMetadata, failureReason } from './diagnostics.js';
import { statsRows } from './stats.js';
import { cleanup, recordOutcome } from './storage.js';
import { isModerator } from './subreddit.js';
import { watch } from './watch.js';
import { DEFAULT_WORK_TITLE, validateWorkTitle } from './work-threads.js';

Devvit.configure({ redditAPI: true, redis: true, http: { domains: ['api.openai.com'] } });

Devvit.addSettings([
  { type: 'string', name: 'openai-api-key', label: 'OpenAI API key', scope: 'app', isSecret: true },
  {
    type: 'boolean', name: 'processing-approved', label: 'Mod team approved sending content to OpenAI',
    defaultValue: false,
    helpText: 'Off means no content processing or reports.',
  },
  {
    type: 'select', name: 'reporting-rules', label: 'Rules that report to the mod queue', multiSelect: true,
    options: rules.map((rule) => ({ label: rule.label, value: rule.name })), defaultValue: [],
    helpText: 'Other rules are still assessed and counted in stats, but never reported.',
  },
  {
    type: 'number', name: 'daily-report-cap', label: 'Maximum mod-queue reports per UTC day', defaultValue: 20,
    onValidate: ({ value }) => value === undefined || !Number.isInteger(value) || value < 0 ? 'Enter a whole number of 0 or more.' : undefined,
  },
  {
    type: 'string', name: 'work-thread-title', label: 'Work thread title', defaultValue: DEFAULT_WORK_TITLE,
    helpText: 'Posts with exactly this title by AutoModerator or a moderator are the work thread. Must match at least 3 past posts. Empty disables the work rule.',
    onValidate: async ({ value }, context) => validateWorkTitle(value, context),
  },
  ...rules.map((rule) => ({
    type: 'number' as const,
    name: `threshold-${rule.name}`,
    label: `${rule.label}: flag threshold`,
    defaultValue: 0.95,
    helpText: 'Model-estimate threshold. Check the stats precision before changing it.',
    onValidate: ({ value }: { value: number | undefined }) =>
      value === undefined || !Number.isFinite(value) || value < 0 || value > 1 ? 'Enter a number from 0 to 1.' : undefined,
  })),
]);

async function requireModerator(context: Context): Promise<void> {
  if (!context.userId) throw new Error('Login required');
  const user = await context.reddit.getUserById(context.userId);

  if (!user || !(await isModerator(user.username, context))) throw new Error('Moderator access required');
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

function outcomeOf(action: string | undefined): 'removed' | 'approved' | undefined {
  if (/^approve(link|comment)$/.test(action ?? '')) return 'approved';

  if (/^(remove|spam)(link|comment)$/.test(action ?? '')) return 'removed';
}

Devvit.addTrigger({
  event: 'ModAction',
  onEvent: async (event, context) => {
    const outcome = outcomeOf(event.action);
    const moderator = event.moderator?.name.toLowerCase() ?? '';
    const id = event.action?.endsWith('comment') ? event.targetComment?.id : event.targetPost?.id;

    if (!outcome || !id || ['automoderator', context.appSlug.toLowerCase(), ''].includes(moderator)) return;
    const recorded = await recordOutcome(id, outcome, context);
    console.log('[rule-watch] mod_action', { id, outcome, recorded });
  },
});

Devvit.addSchedulerJob({ name: 'expire-assessment-index', onRun: async (_event, context) => cleanup(context) });

Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: async (event, context) => {
    console.log('[rule-watch] lifecycle', {
      type: event.type,
      approved: await context.settings.get<boolean>('processing-approved') === true,
      keyPresent: Boolean(await context.settings.get<string>('openai-api-key')),
      reporting: await context.settings.get<string[]>('reporting-rules') ?? [],
    });
    let scheduled = false;

    for (const job of await context.scheduler.listJobs()) {
      if (job.name === 'expire-assessment-index') scheduled = true;
      else await context.scheduler.cancelJob(job.id);
    }

    if (!scheduled) await context.scheduler.runJob({ name: 'expire-assessment-index', cron: '0 0 * * *' });
  },
});

const statsData = z.object({ rows: z.array(z.object({ label: z.string(), value: z.string() })) });

const statsForm = Devvit.createForm((data) => ({
  title: 'Rule Watch stats',
  fields: statsData.parse(data).rows.map((row, index) => ({
    type: 'string' as const, name: `row${index}`, label: row.label, defaultValue: row.value, disabled: true,
  })),
  acceptLabel: 'Done',
  cancelLabel: 'Close',
}), async () => {});

Devvit.addMenuItem({
  label: 'Rule Watch: stats', location: 'subreddit', forUserType: 'moderator',
  onPress: async (_event, context) => {
    try {
      await requireModerator(context);
      context.ui.showForm(statsForm, { rows: await statsRows(context) });
    } catch (error) {
      diagnosticFailure('stats_failed', failureMetadata.parse(error), failureReason.parse(error));
      context.ui.showToast(failureDisplay.parse(error));
    }
  },
});

export default Devvit;

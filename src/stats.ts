import type { TriggerContext } from '@devvit/public-api';
import { rules } from './rules.js';
import { retainedAssessments } from './storage.js';

export type StatsRow = { label: string; value: string };

export async function reportingRules(context: Pick<TriggerContext, 'settings'>): Promise<string[]> {
  return await context.settings.get<string[]>('reporting-rules') ?? [];
}

export async function statsRows(context: Pick<TriggerContext, 'redis' | 'settings'>): Promise<StatsRow[]> {
  const records = await retainedAssessments(context);
  const reporting = await reportingRules(context);
  const count = (delivery: string) => records.filter((record) => record.delivery === delivery).length;
  const items = new Map<string, { flagged: Set<string>; outcome?: 'removed' | 'approved' }>();

  for (const record of records) {
    const item = items.get(record.contentId) ?? { flagged: new Set() };

    for (const name of record.flagged) item.flagged.add(name);
    item.outcome = record.outcome ?? item.outcome;
    items.set(record.contentId, item);
  }

  const rows: StatsRow[] = [{
    label: 'Last 30 days',
    value: `${items.size} items assessed · ${count('reported')} reported · ${count('capped')} over daily cap · ${count('failed')} report failures`,
  }];

  for (const rule of rules) {
    const flagged = [...items.values()].filter((item) => item.flagged.has(rule.name));
    const removed = flagged.filter((item) => item.outcome === 'removed').length;
    const approved = flagged.filter((item) => item.outcome === 'approved').length;
    const precision = removed + approved ? `${Math.round(100 * removed / (removed + approved))}% precision` : 'precision n/a';

    rows.push({
      label: `${rule.label} (${reporting.includes(rule.name) ? 'reporting' : 'counting only'})`,
      value: `${flagged.length} flagged · ${removed} removed · ${approved} approved · ${precision}`,
    });
  }

  const missed = [...items.values()].filter((item) => !item.flagged.size && item.outcome === 'removed').length;
  rows.push({ label: 'Removed by moderators, not flagged', value: String(missed) });

  return rows;
}

export function statsMarkdown(rows: StatsRow[]): string {
  return [
    '| | |', '|---|---|',
    ...rows.map((row) => `| ${row.label} | ${row.value} |`),
    '', 'Precision = removed ÷ (removed + approved) among flags a moderator acted on. Flags nobody acted on are excluded.',
  ].join('\n');
}

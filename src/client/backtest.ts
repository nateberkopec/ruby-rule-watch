import { navigateTo } from '@devvit/web/client';
import { z } from 'zod';
import { escape, list, loadMessages, scores as scoreFormat, t, translateStatic } from './i18n.js';

const serverState = z.object({
  items: z.array(z.object({ id: z.string(), reason: z.string().optional() })),
  rules: z.array(z.object({
    name: z.string(),
    label: z.string(),
    versions: z.array(z.object({ id: z.string(), text: z.string(), live: z.boolean() })),
  })),
  shared: z.string(),
  scores: z.record(z.string(), z.record(z.string(), z.number())),
  judgments: z.record(z.string(), z.enum(['yes', 'no'])),
  queue: z.array(z.object({ rule: z.string().nullable(), wordingId: z.string(), total: z.number(), done: z.number() })),
  error: z.string().nullable(),
});

const itemText = z.union([
  z.object({
    id: z.string(), kind: z.enum(['post', 'comment']), author: z.string(), title: z.string().optional(),
    body: z.string(), parent: z.string().optional(), permalink: z.string(),
  }),
  z.object({ id: z.string(), unavailable: z.literal(true) }),
]);

type ServerState = z.infer<typeof serverState>;

type Version = ServerState['rules'][number]['versions'][number];

type Item = ServerState['items'][number];

const FLOOR = 0.5;

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const thresholdInput = document.querySelector<HTMLInputElement>('#threshold')!;

const wordingInput = document.querySelector<HTMLTextAreaElement>('#wording')!;

const ruleInput = document.querySelector<HTMLSelectElement>('#rule')!;

const rescoreButton = document.querySelector<HTMLButtonElement>('#rescore')!;

let data: ServerState;

const texts = new Map<string, z.infer<typeof itemText>>();

const requested = new Set<string>();

let timer: ReturnType<typeof setTimeout> | undefined;

type View = { rule: string; threshold: number; tab: string; active: Map<string, string>; awaiting?: string };

const ui: View = { rule: '', threshold: 0.95, tab: 'judge', active: new Map() };

type Payload = Record<string, string | string[] | null>;

async function api(path: string, payload?: Payload) {
  const response = await fetch(path, payload
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    : undefined);

  const json = await response.json();

  if (!response.ok) throw new Error(z.object({ error: z.string() }).catch({ error: response.statusText }).parse(json).error);

  return json;
}

const fmt = (value: number) => scoreFormat.format(value);

const ruleData = () => data.rules.find((rule) => rule.name === ui.rule)!;

const versions = () => ruleData().versions;

const current = () => versions().find((version) => version.id === ui.active.get(ui.rule)) ?? versions()[0]!;

const live = () => current().live ? undefined : versions()[0];

const publicItems = () => data.items.filter((item) => item.reason === undefined);

const removedItems = () => data.items.filter((item) => item.reason !== undefined);

const judgmentKey = (id: string) => `${ui.rule}:${id}`;

const judgmentOf = (id: string) => data.judgments[judgmentKey(id)];

const isJudged = (id: string) => judgmentKey(id) in data.judgments;

const scoreOf = (item: Item, version: Version = current()) => data.scores[version.id]?.[item.id] ?? -1;

function flagged(version: Version = current()): Item[] {
  return publicItems().filter((item) => scoreOf(item, version) >= ui.threshold).sort((a, b) => scoreOf(b, version) - scoreOf(a, version));
}

function scoredCount(version: Version = current()): number {
  return publicItems().filter((item) => scoreOf(item, version) >= 0).length;
}

function changes() {
  const before = live();

  if (!before) return { added: [], dropped: [] };
  const now = new Set(flagged().map((item) => item.id));
  const then = new Set(flagged(before).map((item) => item.id));

  return { added: flagged().filter((item) => !then.has(item.id)), dropped: flagged(before).filter((item) => !now.has(item.id)) };
}

function highlightChanges(before: string, after: string): string {
  const a = before.split(' ');
  const b = after.split(' ');
  let start = 0;

  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;

  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const changed = b.slice(start, b.length - end).join(' ');

  return [escape(b.slice(0, start).join(' ')), changed ? `<mark>${escape(changed)}</mark>` : '', escape(b.slice(b.length - end).join(' '))]
    .filter(Boolean).join(' ');
}

function liveTask() {
  return data.queue.find((task) => task.rule === null);
}

function renderStatus(): void {
  const task = liveTask();
  const status = $('status');
  status.classList.toggle('bad', Boolean(data.error));

  if (data.error) status.textContent = t('run.error', { error: data.error });
  else if (task && !data.items.length) status.textContent = t('run.listing');
  else status.textContent = task ? t('run.progress', { done: task.done, total: task.total }) : '';
}

function renderWordings(): void {
  const total = publicItems().length;

  $('wordings').innerHTML = versions().map((version, index) => {
    const active = version.id === current().id;

    const name = version.live
      ? `${escape(t('wording.liveName'))} <span>${escape(t('wording.liveDescription'))}</span>`
      : `${escape(t('wording.rewriteName', { number: index }))} <span>${escape(t('wording.rewriteDescription', { total }))}</span>`;

    const pending = data.queue.some((task) => task.wordingId === version.id && task.rule !== null);
    const choose = active ? escape(t('wording.showingResults')) : `<button type="button" class="small-btn" data-version="${version.id}">${escape(t('wording.showResults'))}</button>`;

    return `<article class="wording${active ? ' active' : ''}">
      <header><strong>${name}</strong><span>${escape(t('wording.flagCount', { count: flagged(version).length, threshold: fmt(ui.threshold) }))}</span></header>
      <p>${version.live ? escape(version.text) : highlightChanges(versions()[0]!.text, version.text)}</p>
      <footer>${pending ? '' : choose}<button type="button" class="small-btn" data-rewrite="${version.id}">${escape(t('wording.rewrite'))}</button></footer>
    </article>`;
  }).join('');
  $('shared').textContent = t('wording.shared', { instructions: data.shared });
}

function renderEditor(): void {
  const total = publicItems().length + removedItems().length;
  const waiting = Boolean(liveTask());
  const task = data.queue.find((entry) => entry.wordingId === ui.awaiting);
  rescoreButton.textContent = waiting ? t('editor.waitForLive') : t('editor.score', { total });
  rescoreButton.disabled = waiting || Boolean(task);
  $('progress').classList.toggle('on', Boolean(task));
  $('progress').querySelector<HTMLElement>('div')!.style.width = task ? `${task.done / Math.max(1, task.total) * 100}%` : '0';
  $('progress-label').textContent = task ? t('editor.progress', { done: task.done, total: task.total }) : '';
}

function renderStrip(): void {
  const bins = Array<number>(50).fill(0);
  let below = 0;

  for (const item of publicItems()) {
    const score = scoreOf(item);

    if (score < 0) continue;

    if (score < FLOOR) {
      below++;
      continue;
    }

    bins[Math.min(49, Math.floor((score - FLOOR) * 100))]!++;
  }

  const peak = Math.max(...bins.map(Math.sqrt), 2);

  $('bars').innerHTML = bins.map((count, index) => {
    const over = FLOOR + index / 100 >= ui.threshold - 0.0001 ? 'over' : '';
    const height = count ? Math.max(6, Math.sqrt(count) / peak * 100) : 0;

    return `<div class="${over}" style="height:${height}%" title="${escape(t('chart.barTitle', { count, score: fmt(FLOOR + index / 100) }))}"></div>`;
  }).join('');
  $('cut').style.left = `calc(${(ui.threshold - FLOOR) / (1 - FLOOR) * 100}% - 1px)`;
  $('cut-label').textContent = fmt(ui.threshold);
  const total = scoredCount();
  $('below').textContent = t('chart.hiddenBelow', { count: below, total, floor: fmt(FLOOR) });
  const count = flagged().length;
  $('headline').innerHTML = `<b>${escape(t('headline.flagged', { count }))}</b> ${escape(t('headline.context', { total, threshold: fmt(ui.threshold) }))}`;
}

function renderMeter(): void {
  const all = flagged();
  const judged = all.filter((item) => isJudged(item.id));
  const yes = judged.filter((item) => judgmentOf(item.id) === 'yes').length;
  const percent = judged.length ? Math.round(yes / judged.length * 100) : 0;
  $('meter-fill').style.width = `${percent}%`;

  $('meter-text').textContent = judged.length
    ? t('meter.progress', { yes, judged: judged.length, count: judged.length, percent, remaining: all.length - judged.length })
    : t('meter.empty');
}

function removals() {
  return removedItems().sort((a, b) => scoreOf(b) - scoreOf(a));
}

function renderTabs(): void {
  const all = flagged();
  const removed = removals();

  const tabs: [string, string][] = [
    ['judge', t('tabs.judge', { count: all.filter((item) => !isJudged(item.id)).length })],
    ['judged', t('tabs.judged', { count: all.filter((item) => isJudged(item.id)).length })],
  ];

  if (live()) {
    const { added, dropped } = changes();
    tabs.push(['changed', t('tabs.changed', { count: added.length + dropped.length })]);
  }

  tabs.push(['removed', t('tabs.removals', { caught: removed.filter((item) => scoreOf(item) >= ui.threshold).length, count: removed.length })]);

  if (!tabs.some(([key]) => key === ui.tab)) ui.tab = 'judge';
  $('tabs').innerHTML = tabs.map(([key, label]) => `<button type="button" role="tab" data-tab="${key}" aria-selected="${key === ui.tab}">${escape(label)}</button>`).join('');
}

function tag(kind: string, text: string): string {
  return `<span class="tag ${kind}">${escape(text)}</span>`;
}

function itemBody(item: Item): string {
  const text = texts.get(item.id);

  if (!text) return `<p class="text">${escape(t('item.loading'))}</p>`;

  if ('unavailable' in text) return `<p class="text">${escape(t('item.unavailable'))}</p>`;
  const parent = text.parent ? `<p class="parent">${escape(text.parent)}</p>` : '';
  const title = text.title ? `<p class="title">${escape(text.title)}</p>` : '';

  return `${parent}${title}<p class="text">${escape(text.body)}</p>`;
}

function itemRow(item: Item, labels = '', judgeable = true): string {
  const score = scoreOf(item);
  const verdict = judgmentOf(item.id);
  const text = texts.get(item.id);
  const kind = item.id.startsWith('t3_') ? 'post' : 'comment';
  const author = text && !('unavailable' in text) && text.author ? `u/${text.author}` : '';
  const replying = kind === 'comment' && text && !('unavailable' in text) && text.parent;
  const reason = item.reason ? tag('', t('tags.reason', { reason: item.reason })) : '';

  return `<li class="item" tabindex="0" data-id="${item.id}">
    <div class="score ${score < ui.threshold ? 'under' : ''}">${fmt(Math.max(0, score))}<small>${escape(t(score >= ui.threshold ? 'item.flagged' : 'item.notFlagged'))}</small></div>
    <div>
      <div class="meta"><span>${escape(t(kind === 'post' ? 'item.post' : 'item.comment', { author }))}</span>${replying ? `<span>${escape(t('item.replyingTo'))}</span>` : ''}${labels}${reason}</div>
      ${itemBody(item)}
      <div class="verdict">
        ${judgeable ? `<button type="button" class="yes" data-judge="yes" aria-pressed="${verdict === 'yes'}">${escape(t('item.worth'))}<kbd>Y</kbd></button>
        <button type="button" class="no" data-judge="no" aria-pressed="${verdict === 'no'}">${escape(t('item.notWorth'))}<kbd>N</kbd></button>` : ''}
        ${text && !('unavailable' in text) ? `<a href="${escape(text.permalink)}" data-open="${escape(text.permalink)}">${escape(t('item.open'))}</a>` : ''}
      </div>
    </div>
  </li>`;
}

function emptyRow(key: string, vars: Record<string, string> = {}): string {
  return `<li class="empty">${escape(t(key, vars))}</li>`;
}

function renderItems(): void {
  const all = flagged();
  const threshold = fmt(ui.threshold);
  let rows: string[];
  let note = '';

  if (ui.tab === 'judge') {
    rows = all.filter((item) => !isJudged(item.id)).map((item) => itemRow(item));
    note = rows.length ? t('notes.judge') : '';

    if (!rows.length) rows = [emptyRow('empty.judge', { threshold })];
  } else if (ui.tab === 'judged') {
    rows = all.filter((item) => isJudged(item.id)).map((item) => itemRow(item));

    if (!rows.length) rows = [emptyRow('empty.judged')];
  } else if (ui.tab === 'changed') {
    const { added, dropped } = changes();
    note = t('notes.changed', { threshold });

    rows = [
      ...added.map((item) => itemRow(item, tag('new', t('tags.newlyFlagged')))),
      ...dropped.map((item) => itemRow(item, tag('dropped', t('tags.noLongerFlagged')))),
    ];

    if (!rows.length) rows = [emptyRow('empty.changed', { threshold })];
  } else {
    const removed = removals();
    const caught = removed.filter((item) => scoreOf(item) >= ui.threshold).length;
    note = removed.length ? t('notes.removals', { count: removed.length, caught, threshold }) : '';

    rows = removed.map((item) => itemRow(item, scoreOf(item) >= ui.threshold
      ? tag('caught', t('tags.wouldHaveFlagged'))
      : tag('missed', t('tags.wouldHaveMissed')), false));

    if (!rows.length) rows = [emptyRow('empty.removals')];
  }

  $('tab-note').textContent = note;
  const focused = document.activeElement?.closest<HTMLElement>('.item')?.dataset.id;
  $('items').innerHTML = rows.join('');

  if (focused) document.querySelector<HTMLElement>(`.item[data-id="${focused}"]`)?.focus({ preventScroll: true });
  observeRows();
}

const observer = new IntersectionObserver((entries) => {
  const ids = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target.getAttribute('data-id') ?? '')
    .filter((id) => id && !requested.has(id));

  if (ids.length) void loadTexts(ids);
}, { rootMargin: '400px' });

function observeRows(): void {
  observer.disconnect();
  document.querySelectorAll('.item').forEach((row) => observer.observe(row));
}

async function loadTexts(ids: string[]): Promise<void> {
  for (const id of ids) requested.add(id);

  for (let start = 0; start < ids.length; start += 25) {
    const loaded = z.array(itemText).parse(await api('/api/text', { ids: ids.slice(start, start + 25) }));

    for (const text of loaded) texts.set(text.id, text);
  }

  renderItems();
}

function render(): void {
  renderStatus();
  renderWordings();
  renderEditor();
  renderStrip();
  renderMeter();
  renderTabs();
  renderItems();
}

async function judge(id: string, verdict: 'yes' | 'no'): Promise<void> {
  const key = judgmentKey(id);
  const next = judgmentOf(id) === verdict ? null : verdict;
  const rows = [...document.querySelectorAll<HTMLElement>('.item')];
  const index = rows.findIndex((row) => row.dataset.id === id);

  if (next) data.judgments[key] = next;
  else delete data.judgments[key];
  document.querySelector<HTMLElement>('.item:focus')?.blur();
  render();
  document.querySelectorAll<HTMLElement>('.item')[ui.tab === 'judge' ? index : index + 1]?.focus();
  await api('/api/judge', { rule: ui.rule, id, verdict: next });
}

async function refresh(): Promise<void> {
  data = serverState.parse(await api('/api/state'));

  if (!ui.rule) {
    ui.rule = data.rules[0]!.name;
    ruleInput.innerHTML = data.rules.map((rule) => `<option value="${rule.name}">${escape(rule.label)}</option>`).join('');
  }

  if (ui.awaiting && !data.queue.some((task) => task.wordingId === ui.awaiting)) {
    ui.active.set(ui.rule, ui.awaiting);
    ui.awaiting = undefined;
    ui.tab = 'changed';
    $('editor').classList.remove('open');
  }

  render();
  poll(data.queue.length ? 4000 : 30_000);
}

function poll(delay: number): void {
  clearTimeout(timer);
  timer = setTimeout(() => void refresh().catch(showError), delay);
}

async function rescore(): Promise<void> {
  rescoreButton.disabled = true;
  const { wordingId } = z.object({ wordingId: z.string() }).parse(await api('/api/rewrite', { rule: ui.rule, text: wordingInput.value }));
  ui.awaiting = wordingId;
  await refresh();
}

function start(): void {
  translateStatic();
  $('steps').innerHTML = list('intro.steps').map((step) => `<li>${escape(step)}</li>`).join('');
  $('axis').innerHTML = [FLOOR, 0.75, 1].map((value) => `<span>${fmt(value)}</span>`).join('');
  ruleInput.addEventListener('change', () => {
    ui.rule = ruleInput.value;
    ui.tab = 'judge';
    $('editor').classList.remove('open');
    render();
  });
  thresholdInput.addEventListener('input', () => {
    ui.threshold = Number(thresholdInput.value);
    render();
  });
  $('cancel').addEventListener('click', () => $('editor').classList.remove('open'));
  rescoreButton.addEventListener('click', () => void rescore().catch(showError));
  $('wordings').addEventListener('click', (event) => {
    const button = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('button') : null;

    if (button?.dataset.version) {
      ui.active.set(ui.rule, button.dataset.version);
      render();
    }

    if (button?.dataset.rewrite) {
      wordingInput.value = versions().find((version) => version.id === button.dataset.rewrite)?.text ?? '';
      $('editor').classList.add('open');
      wordingInput.focus();
    }
  });
  $('tabs').addEventListener('click', (event) => {
    const tab = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-tab]') : null;

    if (!tab?.dataset.tab) return;
    ui.tab = tab.dataset.tab;
    render();
  });
  $('items').addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const link = target?.closest<HTMLElement>('[data-open]');

    if (link?.dataset.open) {
      event.preventDefault();
      navigateTo(link.dataset.open);
    }

    const button = target?.closest<HTMLElement>('[data-judge]');
    const id = button?.closest<HTMLElement>('.item')?.dataset.id;

    if (id && (button?.dataset.judge === 'yes' || button?.dataset.judge === 'no')) void judge(id, button.dataset.judge).catch(showError);
  });
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLElement && event.target.matches('textarea, select, input')) return;
    const row = document.activeElement?.closest<HTMLElement>('.item');
    const rows = [...document.querySelectorAll<HTMLElement>('.item')];

    if (event.key === 'j' || event.key === 'k') {
      const index = row ? rows.indexOf(row) : -1;
      (rows[event.key === 'j' ? index + 1 : Math.max(0, index - 1)] ?? rows[0])?.focus();
      event.preventDefault();
    }

    if (!row?.dataset.id) return;

    if (event.key === 'y') void judge(row.dataset.id, 'yes').catch(showError);

    if (event.key === 'n') void judge(row.dataset.id, 'no').catch(showError);
  });
}

function showError(error: Error): void {
  $('status').classList.add('bad');
  $('status').textContent = error.message;
}

await loadMessages();

start();

await refresh().catch(showError);

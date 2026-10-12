import { z } from 'zod';

const plural = z.object({ one: z.string().optional(), other: z.string() });

const message = z.union([z.string(), z.array(z.string()), plural]);

type Message = z.infer<typeof message>;

type Node = Message | { [key: string]: Node };

const node: z.ZodType<Node> = z.lazy(() => z.union([message, z.record(z.string(), node)]));

const LANG = document.documentElement.lang;

export const numbers = new Intl.NumberFormat(LANG);

export const scores = new Intl.NumberFormat(LANG, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const plurals = new Intl.PluralRules(LANG);

const messages = new Map<string, Message>();

function flatten(value: Node, prefix: string): void {
  const parsed = message.safeParse(value);

  if (parsed.success) {
    messages.set(prefix, parsed.data);

    return;
  }

  for (const [key, child] of Object.entries(z.record(z.string(), node).parse(value))) flatten(child, prefix ? `${prefix}.${key}` : key);
}

export async function loadMessages(): Promise<void> {
  flatten(node.parse(await (await fetch(`locales/${LANG}.json`)).json()), '');
}

export function t(key: string, vars: Record<string, string | number> = {}): string {
  let value = messages.get(key);
  const count = z.number().safeParse(vars.count);

  if (plural.safeParse(value).success) {
    const forms = plural.parse(value);
    value = (count.success && plurals.select(count.data) === 'one' ? forms.one : undefined) ?? forms.other;
  }

  const text = z.string().safeParse(value);

  if (!text.success) return key;

  return text.data.replace(/\{(\w+)\}/g, (_, name: string) => {
    const number = z.number().safeParse(vars[name]);

    return number.success ? numbers.format(number.data) : String(vars[name] ?? '');
  });
}

export function list(key: string): string[] {
  const value = z.array(z.string()).safeParse(messages.get(key));

  return value.success ? value.data : [key];
}

export function escape(text: string): string {
  return text.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}

export function translateStatic(): void {
  document.title = t('app.title');
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n ?? ''); });
  document.querySelectorAll<HTMLElement>('[data-i18n-label]').forEach((element) => element.setAttribute('aria-label', t(element.dataset.i18nLabel ?? '')));
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((element) => { element.title = t(element.dataset.i18nTitle ?? ''); });
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const bundle = JSON.parse(await readFile(new URL('../dist/main.bundle.json', import.meta.url), 'utf8'));

const methods = bundle.dependencies.provides.flatMap(({ definition }) => definition.methods.map(({ name }) => name));

for (const method of [
  'OnPostSubmit', 'OnPostCreate', 'OnPostUpdate',
  'OnCommentSubmit', 'OnCommentCreate', 'OnCommentUpdate', 'OnModAction',
  'OnAppInstall', 'OnAppUpgrade', 'HandleScheduledAction',
]) {
  assert.ok(methods.includes(method), `Built actor does not advertise ${method}; check devvit.json registrations.`);
}

console.log('Actor bundle passed: all nine event handlers and the scheduler are advertised.');

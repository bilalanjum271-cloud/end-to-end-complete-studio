// Every locale must define exactly the keys English defines, with the same {placeholders}.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../src/lib/i18n.ts', import.meta.url), 'utf8');
const block = (name) => {
  const start = src.indexOf(`const ${name}`);
  const end = src.indexOf('\n};', start) === -1 ? src.indexOf('\n} as const;', start) : Math.min(...[src.indexOf('\n};', start), src.indexOf('\n} as const;', start)].filter((i) => i > 0));
  return Object.fromEntries([...src.slice(start, end).matchAll(/'([\w.]+)':\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2]]));
};
const en = block('en');
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

for (const locale of ['ar', 'ur']) {
  test(`${locale} matches English keys and placeholders`, () => {
    const d = block(locale);
    assert.ok(Object.keys(en).length > 100);
    assert.deepEqual(Object.keys(d).sort(), Object.keys(en).sort());
    for (const k of Object.keys(en)) assert.equal(vars(d[k]), vars(en[k]), `${locale}:${k} placeholders differ`);
  });
}

// Design-system rules that can be checked mechanically.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const components = readdirSync(join(src, 'components')).map((f) => [f, readFileSync(join(src, 'components', f), 'utf8')]);
const tokens = readFileSync(join(src, 'tokens.css'), 'utf8');

test('components contain no hard-coded colors', () => {
  for (const [file, code] of components) {
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, `${file} hard-codes a hex color`);
    assert.doesNotMatch(code, /\b(rgb|hsl)a?\(/, `${file} hard-codes a color function`);
  }
});

test('components use only Lucide icons and no emoji', () => {
  for (const [file, code] of components) {
    const iconImports = [...code.matchAll(/from '([^']*icon[^']*)'/g)].map((m) => m[1]);
    assert.deepEqual(iconImports, [], `${file} imports a second icon set`);
    assert.doesNotMatch(code, /\p{Extended_Pictographic}/u, `${file} contains emoji`);
  }
});

test('light theme overrides every color token of the dark theme', () => {
  const [dark, light] = tokens.split("[data-theme='light']");
  const colorVars = [...dark.matchAll(/(--xs-(?:bg|surface|line|fg|accent|success|warning|danger|info|overlay|focus)[\w-]*):/g)].map((m) => m[1]);
  for (const v of new Set(colorVars)) assert.ok(light.includes(`${v}:`), `light theme is missing ${v}`);
});

// WCAG 2.2 AA contrast for the text/background pairs the components use.
const hex = (name, block) => block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))?.[1];
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('text colors meet AA contrast (4.5:1) on every surface in both themes', () => {
  const [dark, light] = tokens.split("[data-theme='light']");
  for (const [theme, block] of [['dark', dark], ['light', light]]) {
    for (const fg of ['--xs-fg', '--xs-fg-muted', '--xs-fg-subtle', '--xs-accent-text', '--xs-danger', '--xs-warning', '--xs-info']) {
      for (const bg of ['--xs-bg', '--xs-surface-1', '--xs-surface-2', '--xs-surface-3']) {
        const r = ratio(hex(fg, block), hex(bg, block));
        assert.ok(r >= 4.5, `${theme}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
    const r = ratio(hex('--xs-accent-fg', block), hex('--xs-accent', block));
    assert.ok(r >= 4.5, `${theme}: accent button text is ${r.toFixed(2)}:1`);
  }
});

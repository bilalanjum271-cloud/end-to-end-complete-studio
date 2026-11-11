import type { Meta, StoryObj } from '@storybook/react';

const colors = ['bg', 'surface-1', 'surface-2', 'surface-3', 'line', 'line-strong', 'fg', 'fg-muted', 'fg-subtle', 'accent', 'accent-soft', 'success', 'warning', 'danger', 'info'];
const type = [['3xl', 'Display'], ['2xl', 'Page title'], ['xl', 'Section title'], ['lg', 'Heading'], ['md', 'Lead'], ['base', 'Interface default'], ['sm', 'Secondary'], ['xs', 'Caption']];

function Foundations() {
  return (
    <div className="flex flex-col gap-12">
      <section>
        <h2 className="mb-4 text-lg font-semibold">Color</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-4">
          {colors.map((c) => (
            <div key={c} className="flex flex-col gap-2">
              <div className="h-16 rounded-md border border-line" style={{ background: `var(--xs-${c})` }} />
              <code className="font-mono text-xs text-fg-muted">--xs-{c}</code>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Type scale</h2>
        <div className="flex flex-col gap-4">
          {type.map(([k, name]) => (
            <div key={k} className="flex items-baseline gap-6">
              <code className="w-24 font-mono text-xs text-fg-subtle">text-{k}</code>
              <span style={{ fontSize: `var(--xs-text-${k})` }} className="leading-tight font-medium">{name}</span>
            </div>
          ))}
          <div className="flex items-baseline gap-6"><code className="w-24 font-mono text-xs text-fg-subtle">mono</code><span className="font-mono text-sm tabular-nums">00:01:24.500 · 120 credits</span></div>
        </div>
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Spacing (8px grid), radius, depth</h2>
        <div className="flex flex-wrap items-end gap-4">
          {[1, 2, 3, 4, 6, 8].map((n) => <div key={n} className="bg-accent-soft" style={{ width: `var(--xs-space-${n})`, height: `var(--xs-space-${n})` }} title={`space-${n}`} />)}
        </div>
        <div className="mt-6 flex flex-wrap gap-6">
          {['sm', 'md', 'lg', 'xl'].map((r) => <div key={r} className="flex size-24 items-center justify-center border border-line bg-surface-2 text-xs text-fg-muted" style={{ borderRadius: `var(--xs-radius-${r})` }}>radius-{r}</div>)}
          {[1, 2, 3].map((s) => <div key={s} className="flex size-24 items-center justify-center rounded-lg bg-surface-2 text-xs text-fg-muted" style={{ boxShadow: `var(--xs-shadow-${s})` }}>shadow-{s}</div>)}
        </div>
      </section>
    </div>
  );
}

const meta: Meta<typeof Foundations> = { title: 'Foundations/Tokens', component: Foundations };
export default meta;
export const Tokens: StoryObj<typeof Foundations> = {};

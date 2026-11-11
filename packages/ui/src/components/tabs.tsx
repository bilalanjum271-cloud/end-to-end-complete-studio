'use client';
import { Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';

export interface TabItem { value: string; label: string; content: ReactNode }

export function Tabs({ items, defaultValue, label }: { items: TabItem[]; defaultValue?: string; label: string }) {
  return (
    <T.Root defaultValue={defaultValue ?? items[0]?.value}>
      <T.List aria-label={label} className="flex gap-1 border-b border-line">
        {items.map((i) => (
          <T.Trigger key={i.value} value={i.value}
            className="-mb-px h-10 border-b-2 border-transparent px-3 text-base font-medium text-fg-muted transition-colors duration-150 ease-xs hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg">
            {i.label}
          </T.Trigger>
        ))}
      </T.List>
      {items.map((i) => (
        <T.Content key={i.value} value={i.value} className="pt-6 animate-fade-in">{i.content}</T.Content>
      ))}
    </T.Root>
  );
}

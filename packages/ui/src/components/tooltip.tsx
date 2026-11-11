'use client';
import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = T.Provider;

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={8}
          className="z-[70] rounded-sm border border-line bg-surface-3 px-2 py-1 text-xs text-fg shadow-2 animate-fade-in">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

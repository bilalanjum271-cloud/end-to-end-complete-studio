'use client';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
}

const overlay = 'fixed inset-0 z-40 bg-overlay animate-fade-in';
const close = 'absolute end-4 top-4 inline-flex size-8 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-3 hover:text-fg';

export function Dialog({ trigger, title, description, children, footer, closeLabel = 'Close', ...rest }: DialogProps) {
  return (
    <D.Root {...rest}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface-1 p-6 shadow-3 animate-pop-in">
          <D.Title className="pe-8 text-lg font-semibold text-fg">{title}</D.Title>
          {description ? <D.Description className="mt-2 text-base text-fg-muted">{description}</D.Description> : null}
          {children ? <div className="mt-6">{children}</div> : null}
          {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
          <D.Close className={close} aria-label={closeLabel}><X className="size-4" aria-hidden /></D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** A panel that slides in from the inline end (right in LTR, left in RTL). */
export function Drawer({ trigger, title, description, children, footer, closeLabel = 'Close', ...rest }: DialogProps) {
  return (
    <D.Root {...rest}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className={overlay} />
        <D.Content className={cn('fixed inset-y-0 end-0 z-50 flex w-[min(28rem,100vw)] flex-col border-s border-line bg-surface-1 shadow-3 animate-slide-in')}>
          <div className="border-b border-line p-6">
            <D.Title className="pe-8 text-lg font-semibold text-fg">{title}</D.Title>
            {description ? <D.Description className="mt-2 text-base text-fg-muted">{description}</D.Description> : null}
          </div>
          <div className="flex-1 overflow-y-auto p-6">{children}</div>
          {footer ? <div className="flex justify-end gap-2 border-t border-line p-4">{footer}</div> : null}
          <D.Close className={close} aria-label={closeLabel}><X className="size-4" aria-hidden /></D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

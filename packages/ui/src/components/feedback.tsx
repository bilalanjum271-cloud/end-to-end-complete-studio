import type { ReactNode } from 'react';
import { cn } from '../cn';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden
      className={cn('rounded-md bg-[linear-gradient(90deg,var(--xs-surface-2)_25%,var(--xs-surface-3)_50%,var(--xs-surface-2)_75%)] bg-[length:200%_100%] animate-shimmer motion-reduce:animate-none', className)} />
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-16 text-center', className)}>
      {icon ? <div className="mb-4 flex size-12 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">{icon}</div> : null}
      <h3 className="text-md font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-2 max-w-md text-base text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function Progress({ value, label, detail }: { value: number; label: string; detail?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="text-fg">{label}</span>
        <span className="font-mono text-xs text-fg-subtle tabular-nums">{detail ?? `${v}%`}</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full origin-left rounded-full bg-accent transition-transform duration-250 ease-xs rtl:origin-right" style={{ transform: `scaleX(${v / 100})` }} />
      </div>
    </div>
  );
}

export type Status = 'queued' | 'running' | 'succeeded' | 'failed' | 'review' | 'draft' | 'soon';
const statusStyle: Record<Status, string> = {
  queued: 'text-fg-muted bg-surface-3',
  running: 'text-info bg-surface-3',
  succeeded: 'text-accent-text bg-accent-soft',
  failed: 'text-danger bg-danger-soft',
  review: 'text-warning bg-surface-3',
  draft: 'text-fg-muted bg-surface-3',
  soon: 'text-fg-muted bg-surface-3',
};

/** Status is never conveyed by color alone: the label is always visible. */
export function StatusBadge({ status, label }: { status: Status; label: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium', statusStyle[status])}>
      <span aria-hidden className={cn('size-1.5 rounded-full bg-current', status === 'running' && 'animate-pulse motion-reduce:animate-none')} />
      {label}
    </span>
  );
}

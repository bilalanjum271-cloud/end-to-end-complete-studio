import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from '../cn';

const control =
  'w-full rounded-md border border-line bg-surface-1 px-3 text-base text-fg placeholder:text-fg-subtle ' +
  'transition-colors duration-150 ease-xs hover:border-line-strong focus:border-focus focus:outline-none ' +
  'focus-visible:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-50 aria-[invalid=true]:border-danger';

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  /** Rendered at the end of the label row, e.g. a "Forgot password?" link. */
  action?: ReactNode;
}

function Shell({ id, label, hint, error, action, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-fg">{label}</label>
        {action}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-sm text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ label, hint, error, action, className, id: given, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <Shell id={id} label={label} hint={hint} error={error} action={action}>
      <input id={id} className={cn(control, 'h-10', className)} aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} {...rest} />
    </Shell>
  );
}

export function Textarea({ label, hint, error, action, className, id: given, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <Shell id={id} label={label} hint={hint} error={error} action={action}>
      <textarea id={id} className={cn(control, 'min-h-24 py-2 leading-relaxed', className)} aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} {...rest} />
    </Shell>
  );
}

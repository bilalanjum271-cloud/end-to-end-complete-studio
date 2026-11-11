import { Slot } from 'radix-ui';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'generate';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  asChild?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-fg text-bg hover:opacity-90',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-danger-soft text-danger hover:bg-danger hover:text-bg',
  generate: 'xs-generate hover:brightness-105',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-sm',
  md: 'h-10 px-4 text-base gap-2 rounded-md',
  lg: 'h-12 px-6 text-md gap-2 rounded-md',
  icon: 'size-8 rounded-sm', // square icon-only button; always pass aria-label
};

export function Button({ variant = 'secondary', size = 'md', loading, icon, asChild, className, children, disabled, ...rest }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none',
        'transition-[background-color,color,opacity,filter] duration-150 ease-xs',
        'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
        variants[variant], sizes[size], className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {asChild ? children : (
        <>
          {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
          {children}
        </>
      )}
    </Comp>
  );
}

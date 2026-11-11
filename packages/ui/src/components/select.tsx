'use client';
import { Select as S } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../cn';

export interface SelectOption { value: string; label: string; disabled?: boolean }

export interface SelectProps {
  label: string;
  /** Visually hide the label (it stays available to screen readers). */
  hideLabel?: boolean;
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  name?: string;
  disabled?: boolean;
  className?: string;
}

export function Select({ label, hideLabel, options, placeholder, className, ...rest }: SelectProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className={cn('text-sm font-medium text-fg', hideLabel && 'sr-only')}>{label}</span>
      <S.Root {...rest}>
        <S.Trigger aria-label={label}
          className={cn('inline-flex h-10 items-center justify-between gap-2 rounded-md border border-line bg-surface-1 px-3 text-base text-fg',
            'transition-colors duration-150 ease-xs hover:border-line-strong data-[placeholder]:text-fg-subtle disabled:opacity-50', className)}>
          <S.Value placeholder={placeholder} />
          <S.Icon><ChevronDown className="size-4 text-fg-subtle" aria-hidden /></S.Icon>
        </S.Trigger>
        <S.Portal>
          <S.Content position="popper" sideOffset={8}
            className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-surface-2 p-1 shadow-2 animate-pop-in">
            <S.Viewport>
              {options.map((o) => (
                <S.Item key={o.value} value={o.value} disabled={o.disabled}
                  className="flex h-8 cursor-default items-center justify-between gap-4 rounded-sm px-2 text-base text-fg outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-3">
                  <S.ItemText>{o.label}</S.ItemText>
                  <S.ItemIndicator><Check className="size-4 text-accent-text" aria-hidden /></S.ItemIndicator>
                </S.Item>
              ))}
            </S.Viewport>
          </S.Content>
        </S.Portal>
      </S.Root>
    </div>
  );
}

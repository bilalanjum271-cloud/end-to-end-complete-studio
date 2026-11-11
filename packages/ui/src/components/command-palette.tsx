'use client';
import { Command } from 'cmdk';
import { Dialog as D } from 'radix-ui';
import { Search } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  shortcut?: string;
  keywords?: string[];
  onSelect: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  placeholder?: string;
  emptyText?: string;
  title?: string;
}

/** Cmd/Ctrl+K palette. The host owns `open`; this component binds the global shortcut. */
export function CommandPalette({ open, onOpenChange, items, placeholder = 'Search actions…', emptyText = 'No results', title = 'Command palette' }: CommandPaletteProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in" />
        <D.Content aria-describedby={undefined}
          className="fixed top-[16vh] left-1/2 z-50 w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface-1 shadow-3 animate-pop-in">
          <D.Title className="sr-only">{title}</D.Title>
          <Command label={title} loop>
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-4 text-fg-subtle" aria-hidden />
              <Command.Input placeholder={placeholder}
                className="h-12 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none" />
              <kbd className="rounded-sm border border-line px-1.5 font-mono text-xs text-fg-subtle">Esc</kbd>
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-2">
              <Command.Empty className="px-2 py-6 text-center text-base text-fg-subtle">{emptyText}</Command.Empty>
              {groups.map((g) => (
                <Command.Group key={g} heading={g}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-fg-subtle">
                  {items.filter((i) => i.group === g).map((i) => (
                    <Command.Item key={i.id} value={`${i.label} ${i.keywords?.join(' ') ?? ''}`}
                      onSelect={() => { onOpenChange(false); i.onSelect(); }}
                      className="flex h-10 cursor-default items-center gap-3 rounded-sm px-2 text-base text-fg-muted select-none data-[selected=true]:bg-surface-3 data-[selected=true]:text-fg">
                      <span className="flex size-4 items-center justify-center text-fg-subtle">{i.icon}</span>
                      <span className="flex-1">{i.label}</span>
                      {i.shortcut ? <kbd className="font-mono text-xs text-fg-subtle">{i.shortcut}</kbd> : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

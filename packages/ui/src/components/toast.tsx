'use client';
import { Toast as T } from 'radix-ui';
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
export interface ToastInput { title: string; description?: string; tone?: ToastTone; action?: { label: string; onClick: () => void } }
interface ToastItem extends ToastInput { id: number }

const Ctx = createContext<(t: ToastInput) => void>(() => undefined);
/** `const toast = useToast(); toast({ title: 'Saved', tone: 'success' })`. Pass `action` for undo. */
export const useToast = () => useContext(Ctx);

const icons = { success: CheckCircle2, error: CircleAlert, info: Info };
const tones = { success: 'text-success', error: 'text-danger', info: 'text-info' };

export function ToastProvider({ children, closeLabel = 'Dismiss' }: { children: ReactNode; closeLabel?: string }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: ToastInput) => setItems((cur) => [...cur.slice(-2), { ...t, id: Date.now() + Math.random() }]), []);
  const remove = useCallback((id: number) => setItems((cur) => cur.filter((i) => i.id !== id)), []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      <T.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((t) => {
          const Icon = icons[t.tone ?? 'info'];
          return (
            <T.Root key={t.id} onOpenChange={(open) => !open && remove(t.id)}
              className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 p-4 shadow-2 animate-pop-in">
              <Icon className={`mt-0.5 size-4 shrink-0 ${tones[t.tone ?? 'info']}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <T.Title className="text-base font-medium text-fg">{t.title}</T.Title>
                {t.description ? <T.Description className="mt-1 text-sm text-fg-muted">{t.description}</T.Description> : null}
              </div>
              {t.action ? (
                <T.Action altText={t.action.label} onClick={t.action.onClick}
                  className="h-8 rounded-sm px-2 text-sm font-medium text-accent-text hover:bg-surface-3">{t.action.label}</T.Action>
              ) : null}
              <T.Close aria-label={closeLabel} className="inline-flex size-6 items-center justify-center rounded-sm text-fg-subtle hover:text-fg">
                <X className="size-4" aria-hidden />
              </T.Close>
            </T.Root>
          );
        })}
        <T.Viewport className="fixed end-4 bottom-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </T.Provider>
    </Ctx.Provider>
  );
}

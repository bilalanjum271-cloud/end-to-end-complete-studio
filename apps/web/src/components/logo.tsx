export function Logo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-semibold tracking-tight text-fg ${className ?? ''}`}>
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
        <rect width="24" height="24" rx="6" fill="var(--xs-accent)" />
        <path d="M7 7l10 10M17 7L7 17" stroke="var(--xs-accent-fg)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span>Xen Studio</span>
    </span>
  );
}

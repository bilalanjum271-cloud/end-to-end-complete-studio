import { Skeleton } from '@xen-studio/ui';

export default function Loading() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true">
      <div className="flex flex-col gap-2"><Skeleton className="h-8 w-56" /><Skeleton className="h-4 w-96 max-w-full" /></div>
      <Skeleton className="aspect-video w-full max-w-3xl" />
    </div>
  );
}

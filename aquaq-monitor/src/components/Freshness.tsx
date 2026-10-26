import { Clock } from 'lucide-react';
import { fmtAgo } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';

export const STALE_AFTER_S = 30;

export function isStale(ts: string | null | undefined, now: number) {
  return !ts || (now - new Date(ts).getTime()) / 1000 > STALE_AFTER_S;
}

/** "Last updated X s ago". Turns amber and says "stale" after 30 s. */
export function Freshness({ ts, className }: { ts: string | null | undefined; className?: string }) {
  const now = useNow();
  if (!ts) return <span className={cn('text-xs text-muted-foreground', className)}>No data yet</span>;
  const age = (now - new Date(ts).getTime()) / 1000;
  const stale = age > STALE_AFTER_S;
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs', stale ? 'font-medium text-amber-700 dark:text-amber-300' : 'text-muted-foreground', className)}
      title={new Date(ts).toISOString()}
    >
      <Clock className="h-3 w-3" aria-hidden />
      Updated {fmtAgo(age)}
      {stale && ' (stale)'}
    </span>
  );
}

/** Wrapper that dims its content when the data is older than 30 s. */
export function StaleDim({ ts, live = true, children, className }: { ts: string | null | undefined; live?: boolean; children: React.ReactNode; className?: string }) {
  const now = useNow();
  return <div className={cn(live && isStale(ts, now) && 'stale', className)}>{children}</div>;
}

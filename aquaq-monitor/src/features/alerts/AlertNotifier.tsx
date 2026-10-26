import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import type { Alert } from '@shared/types.ts';
import { canOperate, useData, useSnapshot } from '@/data/DataProvider';
import { cn } from '@/lib/utils';
import { SEVERITY_BAR, SeverityBadge } from './alertMeta';
import { showLocalNotification } from './notifications';

interface Toast {
  key: string;
  alert: Alert;
  escalated: boolean;
  shownAt: number;
}

const AUTO_DISMISS_MS = 12_000;

/**
 * Watches the alert list and announces new high/critical alerts, and escalations to operators
 * and admins, as in-app toasts (plus local browser notifications in demo mode).
 * Alerts already present when the app loads are not announced.
 */
export function AlertNotifier() {
  const snap = useSnapshot();
  const { user, source } = useData();
  const seen = useRef<Map<string, number> | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    if (!snap.ready) return;
    if (seen.current == null) {
      seen.current = new Map(snap.alerts.map((a) => [a.id, a.escalation_count]));
      return;
    }
    const fresh: Toast[] = [];
    for (const a of snap.alerts) {
      const prev = seen.current.get(a.id);
      if (prev === undefined) {
        seen.current.set(a.id, a.escalation_count);
        if (a.severity === 'high' || a.severity === 'critical') fresh.push({ key: `${a.id}-new`, alert: a, escalated: false, shownAt: Date.now() });
      } else if (a.escalation_count > prev) {
        seen.current.set(a.id, a.escalation_count);
        if (canOperate(user)) fresh.push({ key: `${a.id}-esc-${a.escalation_count}`, alert: a, escalated: true, shownAt: Date.now() });
      }
    }
    if (!fresh.length) return;
    setToasts((t) => [...fresh, ...t].slice(0, 4));
    if (source.kind === 'demo') {
      for (const t of fresh) {
        void showLocalNotification(
          `${t.escalated ? 'Escalated: ' : ''}${t.alert.title}`,
          t.alert.message,
          t.alert.dedup_key,
          t.alert.severity === 'critical',
          `/alerts?id=${t.alert.id}`,
        );
      }
    }
  }, [snap.ready, snap.alerts, user, source.kind]);

  useEffect(() => {
    const timers = toasts
      .filter((t) => t.alert.severity !== 'critical')
      .map((t) =>
        window.setTimeout(() => setToasts((all) => all.filter((x) => x.key !== t.key)), Math.max(0, t.shownAt + AUTO_DISMISS_MS - Date.now())),
      );
    return () => timers.forEach(clearTimeout);
  }, [toasts]);

  const dismiss = (key: string) => setToasts((all) => all.filter((x) => x.key !== key));

  return (
    <div aria-live="polite" className="pointer-events-none fixed left-1/2 top-2 z-[1500] flex w-[min(24rem,calc(100vw-1rem))] -translate-x-1/2 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.key}
          role={t.alert.severity === 'critical' ? 'alert' : 'status'}
          className={cn('pointer-events-auto rounded-md border border-l-4 bg-card p-3 text-sm shadow-lg', SEVERITY_BAR[t.alert.severity])}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={t.alert.severity} />
              {t.escalated && <span className="text-xs font-semibold text-red-800 dark:text-red-200">Escalated: not acknowledged</span>}
            </div>
            <button onClick={() => dismiss(t.key)} className="rounded p-1 hover:bg-muted" aria-label="Dismiss notification">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <div className="mt-1 font-semibold">{t.alert.title}</div>
          <p className="line-clamp-2 text-xs text-muted-foreground">{t.alert.message}</p>
          <Link to={`/alerts?id=${t.alert.id}`} onClick={() => dismiss(t.key)} className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
            Open in notification centre
          </Link>
        </div>
      ))}
    </div>
  );
}

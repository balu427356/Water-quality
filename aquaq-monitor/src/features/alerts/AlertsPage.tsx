import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bell, BellOff, Repeat, Rocket } from 'lucide-react';
import type { Alert, AlertCategory, AlertSeverity, AlertStatus } from '@shared/types.ts';
import { canOperate, useData, useSnapshot, useUser } from '@/data/DataProvider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/form';
import { EmptyState } from '@/components/ChartCard';
import { PageHeader } from '@/features/layout/AppShell';
import { fmtAgo, fmtDateTime } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';
import { AlertStatusLabel, CATEGORY_LABEL, SEVERITY_BAR, SeverityBadge } from './alertMeta';
import { disableNotifications, enableNotifications, notificationsEnabled, notificationsSupported } from './notifications';

type StatusFilter = 'active' | AlertStatus | 'all';

export function AlertsPage() {
  const snap = useSnapshot();
  const [params, setParams] = useSearchParams();
  const focusId = params.get('id');
  const [severity, setSeverity] = useState<'all' | AlertSeverity>('all');
  const [category, setCategory] = useState<'all' | AlertCategory>('all');
  const [zone, setZone] = useState('all');
  const [status, setStatus] = useState<StatusFilter>(focusId ? 'all' : 'active');

  const list = useMemo(
    () =>
      snap.alerts.filter(
        (a) =>
          (severity === 'all' || a.severity === severity) &&
          (category === 'all' || a.category === category) &&
          (zone === 'all' || (zone === 'none' ? a.zone_id == null : a.zone_id === zone)) &&
          (status === 'all' || (status === 'active' ? a.status !== 'resolved' : a.status === status)),
      ),
    [snap.alerts, severity, category, zone, status],
  );

  useEffect(() => {
    if (!focusId) return;
    document.getElementById(`alert-${focusId}`)?.scrollIntoView({ block: 'center' });
  }, [focusId, list.length]);

  const counts = useMemo(() => {
    const c = { critical: 0, high: 0, warning: 0, info: 0 };
    for (const a of snap.alerts) if (a.status !== 'resolved') c[a.severity] += 1;
    return c;
  }, [snap.alerts]);

  return (
    <div className="pb-6">
      <PageHeader
        title="Alerts"
        description="Open → Acknowledged → Resolved. Repeats of the same zone, rule and parameter are merged with a count."
        actions={<NotificationToggle />}
      />
      <div className="px-4 md:px-6">
        <p className="mb-3 flex flex-wrap gap-2 text-sm" aria-label="Unresolved alerts by severity">
          {(['critical', 'high', 'warning', 'info'] as const).map((s) => (
            <button key={s} onClick={() => setSeverity(severity === s ? 'all' : s)} aria-pressed={severity === s} className="rounded-full">
              <SeverityBadge severity={s} className={cn('text-sm', severity === s && 'ring-2 ring-ring')} />
              <span className="ml-1 tabular-nums">{counts[s]}</span>
            </button>
          ))}
        </p>

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Filter id="f-status" label="Status" value={status} onChange={(v) => setStatus(v as StatusFilter)}>
            <option value="active">Open + acknowledged</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Filter>
          <Filter id="f-sev" label="Severity" value={severity} onChange={(v) => setSeverity(v as typeof severity)}>
            <option value="all">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </Filter>
          <Filter id="f-cat" label="Category" value={category} onChange={(v) => setCategory(v as typeof category)}>
            <option value="all">All</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Filter>
          <Filter id="f-zone" label="Zone" value={zone} onChange={setZone}>
            <option value="all">All</option>
            {snap.zones.map((z) => (
              <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
            ))}
            <option value="none">No zone (boat, sensors)</option>
          </Filter>
          {focusId && (
            <Button variant="ghost" size="sm" onClick={() => setParams({})}>
              Clear highlight
            </Button>
          )}
        </div>

        {list.length === 0 ? (
          <Card>
            <EmptyState text={snap.alerts.length ? 'No alerts match these filters.' : 'No alerts yet.'} />
          </Card>
        ) : (
          <ul className="space-y-2" aria-label="Alerts">
            {list.map((a) => (
              <li key={a.id} id={`alert-${a.id}`}>
                <AlertCard alert={a} highlighted={a.id === focusId} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Filter({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <div>
      <Label htmlFor={id} className="block text-xs">{label}</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </Select>
    </div>
  );
}

export function AlertCard({ alert: a, highlighted, compact }: { alert: Alert; highlighted?: boolean; compact?: boolean }) {
  const snap = useSnapshot();
  const { source } = useData();
  const user = useUser();
  const now = useNow(10_000);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = snap.zones.find((z) => z.id === a.zone_id);
  const who = (id: string | null) => snap.profiles.find((p) => p.id === id)?.full_name ?? id ?? '';
  const staff = canOperate(user);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setResolving(false);
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function submitResolve(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      setError('A resolution note is required.');
      return;
    }
    void act(() => source.resolveAlert(user, a.id, note));
  }

  return (
    <Card className={cn('border-l-4 p-3', SEVERITY_BAR[a.severity], highlighted && 'ring-2 ring-ring', a.status === 'resolved' && 'opacity-75')}>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={a.severity} />
        <AlertStatusLabel status={a.status} />
        <span className="text-xs text-muted-foreground">{CATEGORY_LABEL[a.category]}</span>
        {a.count > 1 && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Merged repeats">
            <Repeat className="h-3 w-3" aria-hidden /> ×{a.count}
          </span>
        )}
        {a.escalation_count > 0 && a.status === 'open' && (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-900 dark:bg-red-950 dark:text-red-100">
            Escalated to all operators and admins{a.escalation_count > 1 ? ` (×${a.escalation_count})` : ''}
          </span>
        )}
        {a.action === 'propose_early_mission' && (
          <span className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground">
            <Rocket className="h-3 w-3" aria-hidden /> Early mission proposed
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground" title={fmtDateTime(a.updated_at)}>
          {fmtAgo((now - new Date(a.updated_at).getTime()) / 1000)}
        </span>
      </div>

      <h3 className="mt-1 font-semibold leading-snug">{a.title}</h3>
      <p className="text-sm">{a.message}</p>

      {!compact && (
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="inline text-muted-foreground">Where: </dt>
            <dd className="inline">
              {zone ? (
                <Link className="text-primary hover:underline" to={`/zones/${zone.id}`}>
                  Zone {zone.code} · {zone.name}
                </Link>
              ) : (
                '–'
              )}
              {a.source_id && ` · ${a.source_id}`}
            </dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">First seen: </dt>
            <dd className="inline">{fmtDateTime(a.created_at)}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">Latest: </dt>
            <dd className="inline">{fmtDateTime(a.updated_at)}</dd>
          </div>
          {a.value != null && (
            <div>
              <dt className="inline text-muted-foreground">Value vs limit: </dt>
              <dd className="inline font-medium tabular-nums">
                {a.value} {a.limit_text ? `vs ${a.limit_text}` : ''}
              </dd>
            </div>
          )}
        </dl>
      )}

      <p className="mt-2 rounded bg-muted px-2 py-1 text-sm">
        <span className="font-medium">Suggested action: </span>
        {a.suggested_action}
      </p>

      {(a.acknowledged_at || a.resolved_at) && (
        <p className="mt-2 text-xs text-muted-foreground">
          {a.acknowledged_at && `Acknowledged by ${who(a.acknowledged_by)} at ${fmtDateTime(a.acknowledged_at)}.`}{' '}
          {a.resolved_at && (
            <>
              Resolved by {who(a.resolved_by)} at {fmtDateTime(a.resolved_at)}: <span className="text-foreground">“{a.resolution_note}”</span>
            </>
          )}
        </p>
      )}

      {staff && a.status !== 'resolved' && (
        <div className="mt-2">
          {resolving ? (
            <form onSubmit={submitResolve} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1">
                <Label htmlFor={`note-${a.id}`} className="block text-xs">
                  Resolution note (required)
                </Label>
                <Input id={`note-${a.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done or found" autoFocus />
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                Resolve
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setResolving(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {a.status === 'open' && (
                <Button size="sm" disabled={busy} onClick={() => act(() => source.acknowledgeAlert(user, a.id))}>
                  Acknowledge
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setResolving(true)}>
                Resolve…
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function NotificationToggle() {
  const { source } = useData();
  const user = useUser();
  const [on, setOn] = useState(notificationsEnabled);
  const [msg, setMsg] = useState<string | null>(null);
  if (!notificationsSupported()) return <span className="text-xs text-muted-foreground">Browser notifications not supported here</span>;

  async function toggle() {
    setMsg(null);
    try {
      if (on) {
        await disableNotifications(source, user);
        setOn(false);
        setMsg('Notifications turned off on this device.');
      } else {
        setMsg(await enableNotifications(source, user));
        setOn(true);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={() => void toggle()} aria-pressed={on}>
        {on ? <BellOff className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
        {on ? 'Turn off notifications' : 'Notify me on this device'}
      </Button>
      {msg && (
        <span role="status" className="max-w-xs text-right text-xs text-muted-foreground">
          {msg}
        </span>
      )}
    </div>
  );
}

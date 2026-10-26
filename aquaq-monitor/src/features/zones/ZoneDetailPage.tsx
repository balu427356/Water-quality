import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, ArrowLeft, Bell, FlaskConical, ShieldCheck } from 'lucide-react';
import type { RiskTier } from '@shared/types.ts';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { paramName, zoneHistory, zoneSummaries } from '@/data/selectors';
import { LakeMap } from '@/components/map/LakeMap';
import { TierBadge, TrendIndicator } from '@/components/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, LoadingState } from '@/components/ChartCard';
import { PageHeader } from '@/features/layout/AppShell';
import { SOLVER_LABEL } from '@/features/missions/MissionsPage';
import { DAY_MS, fmtDate, fmtDateTime, fmtShortDate } from '@/lib/time';
import { fmtNum } from '@/lib/utils';


export function ZoneDetailPage() {
  const { zoneId = '' } = useParams();
  const snap = useSnapshot();
  const zone = snap.zones.find((z) => z.id === zoneId);
  const summary = zoneSummaries(snap).find((s) => s.zone.id === zoneId);
  const history = zoneHistory(snap, zoneId).slice(-6);
  const [since] = useState(() => new Date(Date.now() - 90 * DAY_MS).toISOString());
  const [showAnomalies, setShowAnomalies] = useState(true);
  const anomalies = useReadings(zone ? { zoneIds: [zone.id], from: since, maxTrust: 1.01 } : null);
  const tiers = Object.fromEntries(zoneSummaries(snap).map((s) => [s.zone.id, s.score?.risk_tier])) as Record<string, RiskTier | undefined>;

  const lastPlan = useMemo(() => {
    const mz = snap.missionZones.filter((m) => m.zone_id === zoneId);
    const missions = snap.missions.filter((m) => mz.some((x) => x.mission_id === m.id)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const m = missions[0];
    return m ? { mission: m, zone: mz.find((x) => x.mission_id === m.id)! } : null;
  }, [snap.missions, snap.missionZones, zoneId]);

  const timeline = useMemo(() => {
    type Item = { ts: string; kind: 'survey' | 'anomaly' | 'alert'; text: string; lowTrust?: boolean; alertId?: string };
    const items: Item[] = history.map((h) => ({
      ts: h.survey.started_at,
      kind: 'survey',
      text: `Survey ${h.survey.id}: R ${h.score.risk_R.toFixed(2)}, T ${h.score.trust_T.toFixed(2)}, ${h.score.risk_tier}${h.score.trust_gate === 'lab_review' ? ' (sent to lab review)' : ''}`,
    }));
    for (const a of snap.alerts.filter((x) => x.zone_id === zoneId)) {
      items.push({
        ts: a.created_at,
        kind: 'alert',
        alertId: a.id,
        text: `${a.severity.toUpperCase()} alert: ${a.title}${a.count > 1 ? ` (×${a.count})` : ''} · ${a.status}`,
      });
    }
    const groups = new Map<string, typeof anomalies.data>();
    for (const r of anomalies.data) groups.set(r.ts.slice(0, 16), [...(groups.get(r.ts.slice(0, 16)) ?? []), r]);
    for (const rs of showAnomalies ? [...groups.values()].slice(-40) : []) {
      const low = rs.every((r) => (r.trust_T ?? 0) < snap.settings.trust_threshold);
      items.push({
        ts: rs[0].ts,
        kind: 'anomaly',
        lowTrust: low,
        text: `${low ? 'Low-trust anomaly (possible sensor fault)' : 'Anomaly'}: ${rs.map((r) => `${paramName(snap, r.parameter_key)} ${r.value} (T ${r.trust_T})`).join(', ')} · ${rs[0].source_id}`,
      });
    }
    return items.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 60);
  }, [history, anomalies.data, snap, zoneId, showAnomalies]);

  if (!zone) return <EmptyState text="Zone not found." />;
  const score = summary?.score;
  const drivers = score?.top_drivers ?? [];
  const unsafe = drivers.filter((d) => d.contribution > 0).slice(0, 3);
  const safe = [...drivers].reverse().filter((d) => d.contribution <= 0).slice(0, 3);
  const chartData = history.map((h) => ({ t: new Date(h.survey.started_at).getTime(), R: h.score.risk_R, T: h.score.trust_T }));

  return (
    <div className="pb-6">
      <PageHeader
        title={`Zone ${zone.code} · ${zone.name}`}
        description={zone.notes}
        actions={
          <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Dashboard
          </Link>
        }
      />
      <div className="grid gap-3 px-4 md:px-6 lg:grid-cols-3">
        <Card>
          <CardContent className="pt-4">
            <div className="h-48 overflow-hidden rounded-md border">
              <LakeMap snap={snap} tiers={tiers} focusZone={zone} interactive={false} className="h-full w-full" layers={{ route: false, trail: false, samples: false }} />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">Risk R</dt><dd className="text-xl font-semibold tabular-nums">{score?.risk_R.toFixed(2) ?? '–'}</dd></div>
              <div className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">Trust T</dt><dd className="text-xl font-semibold tabular-nums">{score?.trust_T.toFixed(2) ?? '–'}</dd></div>
              <div className="rounded-md border p-2"><dt className="text-xs text-muted-foreground">Tier</dt><dd className="mt-1"><TierBadge tier={score?.risk_tier} /></dd></div>
            </dl>
            {summary && <div className="mt-2 text-sm">Since last survey: <TrendIndicator trend={summary.trend} /></div>}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Trend over the last {history.length} surveys</CardTitle></CardHeader>
          <CardContent>
            <div className="h-56">
              <ResponsiveContainer>
                <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                  <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t) => fmtShortDate(t)} fontSize={11} />
                  <YAxis domain={[0, 1]} fontSize={11} width={32} />
                  <ReferenceLine y={snap.settings.trust_threshold} stroke="#94a3b8" strokeDasharray="4 4" label={{ value: 'trust threshold', fontSize: 10, position: 'insideBottomRight' }} />
                  <Tooltip labelFormatter={(t) => fmtDate(Number(t))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line dataKey="R" name="Risk R" stroke="#dc2626" strokeWidth={2} isAnimationActive={false} />
                  <Line dataKey="T" name="Trust T" stroke="#0e7490" strokeWidth={2} strokeDasharray="5 3" isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Why this score</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <DriverList title="Pushing toward unsafe" items={unsafe} snapName={(k) => paramName(snap, k)} tone="bad" />
            <DriverList title="Pushing toward safe" items={safe} snapName={(k) => paramName(snap, k)} tone="good" />
            <div className="rounded-md border p-3 sm:col-span-2">
              <h3 className="text-sm font-semibold">Trust gate</h3>
              {score ? (
                score.trust_gate === 'auto_accept' ? (
                  <p className="mt-1 flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 text-green-700" aria-hidden /> Auto-accept: trusted and clearly inside its tier.</p>
                ) : (
                  <p className="mt-1 flex items-start gap-2 text-sm"><FlaskConical className="mt-0.5 h-4 w-4 text-amber-700" aria-hidden /><span><strong>Lab review.</strong> {score.trust_gate_reason}</span></p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">No score yet.</p>
              )}
              <h3 className="mt-3 text-sm font-semibold">Last plan</h3>
              {lastPlan ? (
                <p className="mt-1 text-sm">
                  Mission {lastPlan.mission.id}, solver <strong>{SOLVER_LABEL[lastPlan.mission.solver]}</strong>: {lastPlan.zone.level.replace('_', ' ')} ({lastPlan.zone.reason})
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">Not included in a plan yet.</p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">Surveys, alerts and anomalies (last 90 days).</p>
            <label className="mb-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={showAnomalies} onChange={(e) => setShowAnomalies(e.target.checked)} /> Include raw anomalies
            </label>
            {anomalies.loading ? (
              <LoadingState />
            ) : timeline.length === 0 ? (
              <EmptyState text="Nothing recorded for this zone yet." />
            ) : (
              <ol className="max-h-96 space-y-2 overflow-y-auto text-sm">
                {timeline.map((t, i) => (
                  <li key={i} className="border-l-2 pl-3" style={{ borderColor: t.kind === 'survey' ? '#0e7490' : t.kind === 'alert' ? '#7c3aed' : t.lowTrust ? '#d97706' : '#dc2626' }}>
                    <div className="text-xs text-muted-foreground">{fmtDateTime(t.ts)}</div>
                    <div className="flex items-start gap-1">
                      {t.kind === 'anomaly' && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {t.kind === 'alert' && <Bell className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {t.alertId ? (
                        <Link to={`/alerts?id=${t.alertId}`} className="text-primary hover:underline">
                          {t.text}
                        </Link>
                      ) : (
                        t.text
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DriverList({ title, items, snapName, tone }: { title: string; items: { parameter_key: string; value: number; limit: string; contribution: number }[]; snapName: (k: string) => string; tone: 'good' | 'bad' }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">None</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {items.map((d) => (
            <li key={d.parameter_key} className="flex justify-between gap-2 rounded border px-2 py-1">
              <span>{tone === 'bad' ? '▲' : '▼'} {snapName(d.parameter_key)}</span>
              <span className="tabular-nums text-muted-foreground">
                {fmtNum(d.value)} vs {d.limit}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

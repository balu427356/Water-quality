import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatLimit, limitStatus, trendOf } from '@shared/limits.ts';
import { LEVEL_LABEL } from '@shared/planner.ts';
import type { Alert, RiskTier } from '@shared/types.ts';
import { useData, useSnapshot } from '@/data/DataProvider';
import { completedSurveys, paramName, scoresBySurvey, worstTier } from '@/data/selectors';
import { useReadings } from '@/data/useReadings';
import { Button } from '@/components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LimitBadge, TierBadge, TrendIndicator } from '@/components/status';
import { EmptyState, LoadingState } from '@/components/ChartCard';
import { LakeMap } from '@/components/map/LakeMap';
import { SeverityBadge } from '@/features/alerts/alertMeta';
import { SOLVER_LABEL } from '@/features/missions/MissionsPage';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtDateTime } from '@/lib/time';
import { fmtNum } from '@/lib/utils';
import { readingRows } from './exportRows';

export function SurveyReportPage() {
  const { surveyId = '' } = useParams();
  const snap = useSnapshot();
  const { source, user } = useData();
  const surveys = completedSurveys(snap);
  const idx = surveys.findIndex((s) => s.id === surveyId);
  const survey = surveys[idx];
  const prev = idx > 0 ? surveys[idx - 1] : undefined;
  const scores = scoresBySurvey(snap, survey?.id);
  const prevScores = scoresBySurvey(snap, prev?.id);
  const { data: readings, loading } = useReadings(survey ? { surveyIds: [survey.id] } : null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [generatedAt] = useState(() => new Date());

  // Period covered: from the previous survey's end to this survey's end.
  const windowFrom = prev?.ended_at ?? prev?.started_at ?? survey?.started_at ?? '';
  const windowTo = survey?.ended_at ?? survey?.started_at ?? '';
  useEffect(() => {
    if (!survey) return;
    void source.listAlerts(windowFrom, windowTo).then(setAlerts).catch(() => setAlerts([]));
  }, [source, survey, windowFrom, windowTo]);

  const tiers = Object.fromEntries(Object.values(scores).map((z) => [z.zone_id, z.risk_tier])) as Record<string, RiskTier | undefined>;
  const missions = snap.missions.filter((m) => m.id === survey?.mission_id || (m.started_at && m.started_at >= windowFrom && m.started_at <= windowTo));
  const rows = snap.zones.map((z) => {
    const s = scores[z.id];
    const p = prevScores[z.id];
    return { zone: z, s, p, trend: s ? trendOf(s.risk_R, p?.risk_R) : ('stable' as const) };
  });
  const worse = rows.filter((r) => r.trend === 'worsening');
  const better = rows.filter((r) => r.trend === 'improving');
  const lowTrust = readings.filter((r) => r.edge_anomaly_flag && r.trust_T != null && r.trust_T < snap.settings.trust_threshold).length;
  const anomalies = readings.filter((r) => r.edge_anomaly_flag).length;

  const means = useMemo(() => {
    const out: { zone: string; key: string; mean: number; n: number }[] = [];
    for (const z of snap.zones) {
      for (const p of snap.parameters.filter((x) => x.enabled && x.limit_type !== 'none')) {
        const vs = readings.filter((r) => r.zone_id === z.id && r.parameter_key === p.key).map((r) => r.value);
        if (vs.length) out.push({ zone: z.id, key: p.key, mean: vs.reduce((a, b) => a + b, 0) / vs.length, n: vs.length });
      }
    }
    return out;
  }, [readings, snap.zones, snap.parameters]);
  const chart = rows.map((r) => ({ zone: `Zone ${r.zone.code}`, previous: r.p?.risk_R ?? null, current: r.s?.risk_R ?? null }));

  if (!survey) return <EmptyState text="Survey not found." />;

  return (
    <article className="mx-auto max-w-5xl px-4 pb-10 pt-4 text-sm md:px-6 print:max-w-none print:p-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link to="/reports" className="inline-flex items-center gap-1 text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Reports
        </Link>
        <div className="flex gap-2">
          <Button variant="outline" disabled={loading || !readings.length} onClick={() => downloadCsv(`aquaq-${survey.id}-readings`, readingRows(readings, snap.parameters, snap.settings))}>
            <Download className="h-4 w-4" aria-hidden /> Readings CSV
          </Button>
          <Button onClick={() => window.print()} title="Opens the print dialog; choose “Save as PDF”">
            <Printer className="h-4 w-4" aria-hidden /> Export PDF
          </Button>
        </div>
      </div>

      <header className="border-b pb-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">AquaQ Monitor · Survey report</p>
        <h1 className="text-2xl font-semibold">
          {snap.waterBody?.name} · {survey.id}
        </h1>
        <p className="text-muted-foreground">
          {survey.type === 'scheduled' ? 'Scheduled' : 'Unscheduled'} survey, {fmtDateTime(survey.started_at)} to {survey.ended_at ? fmtDateTime(survey.ended_at) : '–'}
          {survey.mission_id && ` · mission ${survey.mission_id}`}
        </p>
        <p className="text-xs text-muted-foreground">
          Generated {fmtDateTime(generatedAt)} by {user?.full_name}. Period covered for alerts and missions: {windowFrom ? fmtDate(windowFrom) : '–'} to {fmtDate(windowTo)}.
          {source.kind === 'demo' && ' Demo data from the simulator, not real measurements.'}
        </p>
      </header>

      <section className="mt-4 break-inside-avoid">
        <h2 className="mb-1 text-lg font-semibold">Summary</h2>
        <p className="flex flex-wrap items-center gap-2">
          Overall status <TierBadge tier={worstTier(Object.values(scores))} /> (worst zone).{' '}
          {readings.length.toLocaleString('en-IN')} readings, {anomalies} anomalies, of which {lowTrust} low-trust (likely sensor faults).
        </p>
        <p className="mt-1">
          {prev ? (
            <>
              Compared with {prev.id} ({fmtDate(prev.started_at)}): worsening {worse.length ? worse.map((r) => `zone ${r.zone.code}`).join(', ') : 'none'}; improving{' '}
              {better.length ? better.map((r) => `zone ${r.zone.code}`).join(', ') : 'none'}.
            </>
          ) : (
            'First survey: no comparison.'
          )}
        </p>
      </section>

      <section className="mt-4 break-inside-avoid">
        <h2 className="mb-1 text-lg font-semibold">Zones</h2>
        <Table>
          <THead>
            <TR>
              <TH>Zone</TH>
              <TH>Risk R</TH>
              <TH>Trust T</TH>
              <TH>Tier</TH>
              <TH>Since {prev?.id ?? 'previous'}</TH>
              <TH>Trust gate</TH>
              <TH>Top driver</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map(({ zone, s, p, trend }) => (
              <TR key={zone.id}>
                <TD className="font-medium">
                  {zone.code} · {zone.name}
                </TD>
                <TD className="tabular-nums">
                  {s?.risk_R.toFixed(2) ?? '–'}
                  {s && p && <span className="text-xs text-muted-foreground"> ({s.risk_R - p.risk_R >= 0 ? '+' : ''}{(s.risk_R - p.risk_R).toFixed(2)})</span>}
                </TD>
                <TD className="tabular-nums">{s?.trust_T.toFixed(2) ?? '–'}</TD>
                <TD>
                  <TierBadge tier={s?.risk_tier} />
                </TD>
                <TD>
                  <TrendIndicator trend={trend} />
                </TD>
                <TD className="text-xs">{s ? (s.trust_gate === 'auto_accept' ? 'Auto-accept' : `Lab review: ${s.trust_gate_reason}`) : '–'}</TD>
                <TD className="text-xs">{s?.top_drivers[0] && s.top_drivers[0].contribution > 0 ? `${paramName(snap, s.top_drivers[0].parameter_key)} (${fmtNum(s.top_drivers[0].value)} vs ${s.top_drivers[0].limit})` : 'None'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>

      <section className="mt-4 grid gap-4 md:grid-cols-2 print:grid-cols-2 break-inside-avoid">
        <figure>
          <div className="h-64 overflow-hidden rounded-md border">
            {loading ? (
              <LoadingState />
            ) : (
              <LakeMap
                snap={snap}
                tiers={tiers}
                interactive={false}
                sampleReadings={readings}
                routeMissionId={survey.mission_id ?? '-'}
                className="h-full w-full"
                layers={{ boat: false, trail: false, heatmap: false, stations: true, route: !!survey.mission_id }}
              />
            )}
          </div>
          <figcaption className="mt-1 text-xs text-muted-foreground">Zones coloured by this survey's tier; dots are sampling points (red anomaly, hollow low trust, ★ strongest trusted exceedance).</figcaption>
        </figure>
        <figure>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
                <XAxis dataKey="zone" fontSize={11} />
                <YAxis domain={[0, 1]} fontSize={11} width={32} />
                <ReferenceLine y={snap.settings.tier_cutoffs.critical} stroke="#dc2626" strokeDasharray="4 4" />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {prev && <Bar dataKey="previous" name={`R ${prev.id}`} fill="#94a3b8" isAnimationActive={false} />}
                <Bar dataKey="current" name={`R ${survey.id}`} fill="#0e7490" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <figcaption className="mt-1 text-xs text-muted-foreground">Risk R per zone, this survey against the previous one. Dashed line: Critical cut-off.</figcaption>
        </figure>
      </section>

      <section className="mt-4">
        <h2 className="mb-1 text-lg font-semibold">Parameter means against limits</h2>
        {loading ? (
          <LoadingState />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Parameter</TH>
                {snap.zones.map((z) => (
                  <TH key={z.id}>Zone {z.code}</TH>
                ))}
                <TH>Limit</TH>
              </TR>
            </THead>
            <TBody>
              {snap.parameters
                .filter((p) => p.enabled && p.limit_type !== 'none' && means.some((m) => m.key === p.key))
                .map((p) => (
                  <TR key={p.key} className="break-inside-avoid">
                    <TD className="font-medium">{p.name}</TD>
                    {snap.zones.map((z) => {
                      const m = means.find((x) => x.zone === z.id && x.key === p.key);
                      return (
                        <TD key={z.id} className="tabular-nums">
                          {m ? (
                            <span className="inline-flex flex-wrap items-center gap-1">
                              {fmtNum(m.mean)} <LimitBadge status={limitStatus(m.mean, p, snap.settings.near_limit_pct)} />
                            </span>
                          ) : (
                            '–'
                          )}
                        </TD>
                      );
                    })}
                    <TD className="whitespace-nowrap text-xs">{formatLimit(p)}</TD>
                  </TR>
                ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="mt-4 break-inside-avoid">
        <h2 className="mb-1 text-lg font-semibold">Missions run</h2>
        {missions.length === 0 ? (
          <p className="text-muted-foreground">No missions in this period (seeded history has no mission records).</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Mission</TH>
                <TH>Solver</TH>
                <TH>Energy</TH>
                <TH>Plan</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {missions.map((m) => (
                <TR key={m.id}>
                  <TD className="font-medium">
                    {m.id} · {m.name}
                  </TD>
                  <TD>{SOLVER_LABEL[m.solver]}</TD>
                  <TD className="tabular-nums">
                    {m.energy_planned} / {m.energy_budget}
                  </TD>
                  <TD className="text-xs">
                    {snap.missionZones
                      .filter((z) => z.mission_id === m.id)
                      .map((z) => `${z.zone_id}: ${LEVEL_LABEL[z.level]}`)
                      .join(' · ')}
                  </TD>
                  <TD className="capitalize">{m.status}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="mt-4">
        <h2 className="mb-1 text-lg font-semibold">Alerts raised</h2>
        {alerts == null ? (
          <LoadingState />
        ) : alerts.length === 0 ? (
          <p className="text-muted-foreground">No alerts in this period.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Severity</TH>
                <TH>Alert</TH>
                <TH>Count</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {alerts.map((a) => (
                <TR key={a.id} className="break-inside-avoid">
                  <TD className="whitespace-nowrap text-xs">{fmtDateTime(a.created_at)}</TD>
                  <TD>
                    <SeverityBadge severity={a.severity} />
                  </TD>
                  <TD>{a.title}</TD>
                  <TD className="tabular-nums">{a.count}</TD>
                  <TD className="capitalize">
                    {a.status}
                    {a.resolution_note && <span className="block text-xs normal-case text-muted-foreground">“{a.resolution_note}”</span>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <footer className="mt-6 border-t pt-2 text-xs text-muted-foreground break-inside-avoid">
        Scores: risk R and trust T per zone from the scoring step (classical method). Solvers are labelled as reported by the planner; a mock or
        simulated solver is never presented as quantum hardware. Limits as configured in Settings at the time of printing; check them against the
        applicable standard (for example BIS IS 10500 or CPCB criteria).
      </footer>
    </article>
  );
}

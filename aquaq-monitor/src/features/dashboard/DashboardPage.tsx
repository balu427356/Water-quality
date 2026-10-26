import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Battery, Bell, CalendarClock, Radio, Ship, Waves } from 'lucide-react';
import { formatLimit, limitStatus } from '@shared/limits.ts';
import type { RiskTier } from '@shared/types.ts';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { activeMission, latestPerParameter, latestSurvey, nextSurveyAt, paramName, secondsSince, worstTier, zoneSummaries } from '@/data/selectors';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LimitBadge, TierBadge, TrendIndicator } from '@/components/status';
import { Freshness, StaleDim } from '@/components/Freshness';
import { LakeMap } from '@/components/map/LakeMap';
import { PageHeader } from '@/features/layout/AppShell';
import { fmtCountdown, fmtDate, fmtDateTime } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';

export function DashboardPage() {
  const snap = useSnapshot();
  const now = useNow();
  const nav = useNavigate();
  const summaries = zoneSummaries(snap);
  const overall = worstTier(summaries.map((s) => s.score));
  const tiers = Object.fromEntries(summaries.map((s) => [s.zone.id, s.score?.risk_tier])) as Record<string, RiskTier | undefined>;
  const boat = snap.boats[0];
  const mission = activeMission(snap);
  const latest = latestPerParameter(snap);
  const next = nextSurveyAt(snap);
  const survey = latestSurvey(snap);
  const linkLost = secondsSince(boat?.last_seen, now) > snap.settings.link_loss_timeout_s;
  const lab = useReadings(survey ? { surveyIds: [survey.id], sourceTypes: ['lab'] } : null);
  const latestLab = useMemo(() => {
    const out: Record<string, (typeof lab.data)[number]> = {};
    for (const r of lab.data) if (!out[r.parameter_key] || out[r.parameter_key].ts < r.ts) out[r.parameter_key] = r;
    return out;
  }, [lab.data]);
  const liveSamples = useMemo(() => snap.recentReadings.filter((r) => r.source_type === 'boat'), [snap.recentReadings]);

  return (
    <div className="pb-6">
      <PageHeader title={snap.waterBody?.name ?? 'Dashboard'} description={survey ? `Latest survey ${fmtDate(survey.started_at)} · scores from that survey` : undefined} />

      <section aria-label="Status" className="grid grid-cols-1 gap-3 px-4 sm:grid-cols-2 md:px-6 xl:grid-cols-5">
        <StatusCard icon={Waves} title="Overall water status">
          <TierBadge tier={overall} className="text-sm" />
          <p className="mt-1 text-xs text-muted-foreground">Worst risk tier across {snap.zones.length} zones</p>
        </StatusCard>

        <StatusCard icon={Bell} title="Open alerts">
          <div className="flex gap-2 text-sm">
            {(['critical', 'high', 'warning', 'info'] as const).map((s) => (
              <span key={s} className="rounded border px-1.5 py-0.5 text-xs capitalize text-muted-foreground">
                {s} 0
              </span>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Alert engine arrives in Phase 2.</p>
        </StatusCard>

        <StatusCard icon={Ship} title={`Boat ${boat?.name ?? ''}`}>
          <StaleDim ts={boat?.last_seen}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-semibold">{boat?.mode}</span>
              <span className="inline-flex items-center gap-1">
                <Battery className="h-4 w-4" aria-hidden />
                {Math.round(boat?.battery_pct ?? 0)}%
              </span>
              <span className="inline-flex items-center gap-1">
                <Radio className="h-4 w-4" aria-hidden />
                {linkLost ? 'Link lost' : boat?.link_type}
              </span>
            </div>
          </StaleDim>
          <Freshness ts={boat?.last_seen} />
          {mission && <p className="truncate text-xs text-muted-foreground">Mission {mission.id}</p>}
        </StatusCard>

        <StatusCard icon={Radio} title="Fixed stations">
          <ul className="space-y-0.5 text-sm">
            {snap.stations.map((s) => {
              const age = secondsSince(s.last_seen, now);
              const ok = age < 15 * 60;
              return (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span className="truncate">{s.name}</span>
                  <span className={cn('text-xs', ok ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300')}>
                    {ok ? '● Reporting' : '▲ Late'}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">Report every 5 min</p>
        </StatusCard>

        <StatusCard icon={CalendarClock} title="Next scheduled survey">
          {next ? (
            <>
              <div className="text-sm font-semibold">{fmtDate(next)}</div>
              <p className="text-xs text-muted-foreground">
                In {fmtCountdown(next - now)} · every {snap.settings.survey_interval_days} days
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No surveys yet</p>
          )}
        </StatusCard>
      </section>

      <div className="mt-3 grid grid-cols-1 gap-3 px-4 md:px-6 xl:grid-cols-5">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Zones and live positions</CardTitle>
            <Link to="/map" className="text-sm text-primary underline-offset-2 hover:underline">
              Open live map
            </Link>
          </CardHeader>
          <CardContent>
            <div className="h-72 overflow-hidden rounded-md border">
              <LakeMap
                snap={snap}
                tiers={tiers}
                className="h-full w-full"
                sampleReadings={liveSamples}
                layers={{ route: false, samples: false }}
                onZoneClick={(id) => nav(`/zones/${id}`)}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Zones</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Zone</TH>
                  <TH>Risk R</TH>
                  <TH>Trust T</TH>
                  <TH>Tier</TH>
                  <TH>Since last survey</TH>
                  <TH>Top driver</TH>
                </TR>
              </THead>
              <TBody>
                {summaries.map(({ zone, score, trend }) => {
                  const top = score?.top_drivers[0];
                  return (
                    <TR key={zone.id}>
                      <TD>
                        <Link to={`/zones/${zone.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                          {zone.code} · {zone.name}
                        </Link>
                      </TD>
                      <TD className="tabular-nums">{score?.risk_R.toFixed(2) ?? '–'}</TD>
                      <TD className="tabular-nums">
                        {score?.trust_T.toFixed(2) ?? '–'}
                        {score && score.trust_T < snap.settings.trust_threshold && <span className="ml-1 text-xs text-amber-700 dark:text-amber-300">(low)</span>}
                      </TD>
                      <TD>
                        <TierBadge tier={score?.risk_tier} />
                      </TD>
                      <TD>
                        <TrendIndicator trend={trend} />
                      </TD>
                      <TD className="text-sm">{top && top.contribution > 0 ? paramName(snap, top.parameter_key) : <span className="text-muted-foreground">None</span>}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="latest-h" className="mt-3 px-4 md:px-6">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 id="latest-h" className="text-base font-semibold">
            Latest readings
          </h2>
          <span className="text-xs text-muted-foreground">Most recent value from the boat or a station</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {snap.parameters
            .filter((p) => p.enabled)
            .map((p) => {
              const r = latest[p.key] ?? latestLab[p.key];
              const isLab = !latest[p.key] && !!r;
              const status = r ? limitStatus(r.value, p, snap.settings.near_limit_pct) : 'none';
              return (
                <Card key={p.key} className="p-3">
                  <StaleDim ts={r?.ts} live={!isLab}>
                    <div className="text-xs font-medium text-muted-foreground">{p.name}</div>
                    <div className="mt-1 text-xl font-semibold tabular-nums">
                      {r ? r.value : '–'} <span className="text-xs font-normal text-muted-foreground">{p.unit}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">Limit {formatLimit(p)}</div>
                    <div className="mt-1">{r ? <LimitBadge status={status} /> : <span className="text-xs text-muted-foreground">No reading yet</span>}</div>
                  </StaleDim>
                  {r && (
                    <div className="mt-1 text-[11px] text-muted-foreground" title={fmtDateTime(r.ts)}>
                      {isLab ? `Lab sample · ${fmtDate(r.ts)}` : <>{r.source_id} · <Freshness ts={r.ts} className="text-[11px]" /></>}
                    </div>
                  )}
                </Card>
              );
            })}
        </div>
      </section>
    </div>
  );
}

function StatusCard({ icon: Icon, title, children }: { icon: typeof Waves; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden />
        {title}
      </div>
      {children}
    </Card>
  );
}

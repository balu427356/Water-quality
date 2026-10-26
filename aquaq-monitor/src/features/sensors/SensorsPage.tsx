import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Wrench } from 'lucide-react';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { paramName } from '@/data/selectors';
import { HealthBadge } from '@/components/status';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ChartCard } from '@/components/ChartCard';
import { PageHeader } from '@/features/layout/AppShell';
import { DAY_MS, fmtDate, fmtTime } from '@/lib/time';
import { crossCheck } from './crossCheck';


export function SensorsPage() {
  const snap = useSnapshot();
  const [since] = useState(() => new Date(Date.now() - 30 * DAY_MS).toISOString());
  const lowTrust = useReadings({ from: since, maxTrust: snap.settings.trust_threshold });
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of lowTrust.data) m.set(`${r.source_id}|${r.parameter_key}`, (m.get(`${r.source_id}|${r.parameter_key}`) ?? 0) + 1);
    return m;
  }, [lowTrust.data]);
  const owners = Object.fromEntries([...snap.boats.map((b) => [b.id, b.name]), ...snap.stations.map((s) => [s.id, s.name])]);
  const now = Date.now();

  const rows = snap.sensors.map((s) => {
    const days = Math.floor((now - new Date(s.last_calibrated_at).getTime()) / DAY_MS);
    return { s, days, due: days > snap.settings.calibration_due_days, low: counts.get(`${s.owner_id}|${s.parameter_key}`) ?? 0 };
  });

  return (
    <div className="pb-6">
      <PageHeader title="Sensors and stations" description="Probe health, calibration and agreement between the boat and fixed stations." />
      <div className="grid gap-3 px-4 md:px-6">
        <ChartCard
          title="Sensors"
          description={`Calibration is due after ${snap.settings.calibration_due_days} days. Low-trust count = readings with T below ${snap.settings.trust_threshold} in the last 30 days.`}
          loading={lowTrust.loading}
          csv={{ filename: 'sensors', rows: () => rows.map((r) => ({ sensor: r.s.id, owner: owners[r.s.owner_id], parameter: r.s.parameter_key, health: r.s.health, last_calibrated: r.s.last_calibrated_at, days_since_calibration: r.days, low_trust_30d: r.low, maintenance_flag: r.s.maintenance_flag })) }}
        >
          <Table>
            <THead>
              <TR>
                <TH>Sensor</TH>
                <TH>Owner</TH>
                <TH>Parameter</TH>
                <TH>Health</TH>
                <TH>Last calibrated</TH>
                <TH>Days since</TH>
                <TH>Low-trust (30 d)</TH>
                <TH>Maintenance</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map(({ s, days, due, low }) => (
                <TR key={s.id}>
                  <TD className="font-mono text-xs">{s.id}</TD>
                  <TD>{owners[s.owner_id] ?? s.owner_id}</TD>
                  <TD>{paramName(snap, s.parameter_key)}</TD>
                  <TD><HealthBadge health={s.health} /></TD>
                  <TD className="whitespace-nowrap">{fmtDate(s.last_calibrated_at)}</TD>
                  <TD className="tabular-nums">
                    {days}
                    {due && (
                      <Badge className="ml-2 border-amber-700/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                        <AlertTriangle className="h-3 w-3" aria-hidden /> Calibration due
                      </Badge>
                    )}
                  </TD>
                  <TD className="tabular-nums">{low}</TD>
                  <TD>{s.maintenance_flag ? <Badge className="border-red-700/30 bg-red-50 text-red-800"><Wrench className="h-3 w-3" aria-hidden /> Flagged</Badge> : <span className="text-muted-foreground">–</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </ChartCard>

        <div className="grid gap-3 lg:grid-cols-2">
          {snap.stations.map((st) => {
            const cc = crossCheck(st, snap.recentReadings, snap.settings.crosscheck_distance_m, snap.settings.crosscheck_tolerance_pct);
            return (
              <Card key={st.id}>
                <CardHeader>
                  <div>
                    <CardTitle>Cross-check: {st.name}</CardTitle>
                    <CardDescription>
                      Boat readings within {snap.settings.crosscheck_distance_m} m of the station in the last 30 min, against the station. Tolerance ±{snap.settings.crosscheck_tolerance_pct}%.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  {cc.length === 0 ? (
                    <p className="text-sm text-muted-foreground">The boat has not passed within {snap.settings.crosscheck_distance_m} m of this station in the last 30 minutes.</p>
                  ) : (
                    <Table>
                      <THead>
                        <TR><TH>Parameter</TH><TH>Boat</TH><TH>Station</TH><TH>Diff</TH><TH>Result</TH></TR>
                      </THead>
                      <TBody>
                        {cc.map((c) => (
                          <TR key={c.parameter_key}>
                            <TD>{paramName(snap, c.parameter_key)}</TD>
                            <TD className="tabular-nums">{c.boat.value} <span className="text-xs text-muted-foreground">{fmtTime(c.boat.ts)}</span></TD>
                            <TD className="tabular-nums">{c.station.value} <span className="text-xs text-muted-foreground">{fmtTime(c.station.ts)}</span></TD>
                            <TD className="tabular-nums">{c.diffPct.toFixed(1)}%</TD>
                            <TD>
                              {c.exceeds ? (
                                <span className="inline-flex items-center gap-1 text-sm text-amber-800 dark:text-amber-200"><AlertTriangle className="h-4 w-4" aria-hidden /> Sensor warning</span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-sm text-green-800 dark:text-green-200"><CheckCircle2 className="h-4 w-4" aria-hidden /> Agrees</span>
                              )}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Maintenance flags are set automatically when a probe fails 3 confirmation checks in a row. Maintenance tasks and the pre-mission checklist arrive in Phase 3.
        </p>
      </div>
    </div>
  );
}

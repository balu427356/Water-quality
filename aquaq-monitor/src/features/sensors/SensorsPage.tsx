import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, Wrench } from 'lucide-react';
import { canOperate, useData, useSnapshot, useUser } from '@/data/DataProvider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/form';
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
  const { user } = useData();
  const staff = canOperate(user);
  const [taskFor, setTaskFor] = useState<string | null>(null);

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
                {staff && <TH />}
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
                  {staff && (
                    <TD>
                      <Button size="sm" variant="outline" onClick={() => setTaskFor(s.id)} aria-label={`Create maintenance task for ${s.id}`}>
                        <Plus className="h-3.5 w-3.5" aria-hidden /> Task
                      </Button>
                    </TD>
                  )}
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

        <MaintenanceTasks />
        <p className="text-xs text-muted-foreground">
          Maintenance flags are set automatically when a probe fails 3 confirmation checks in a row. Probes that are overdue, unhealthy or flagged fail the
          pre-mission checklist, so a mission cannot start until they are fixed (or an admin overrides with a reason).
        </p>
        {taskFor && <NewTaskDialog sensorId={taskFor} onClose={() => setTaskFor(null)} />}
      </div>
    </div>
  );
}

function NewTaskDialog({ sensorId, onClose }: { sensorId: string; onClose: () => void }) {
  const snap = useSnapshot();
  const { source } = useData();
  const user = useUser();
  const sensor = snap.sensors.find((x) => x.id === sensorId);
  const [title, setTitle] = useState(sensor ? `Calibrate ${paramName(snap, sensor.parameter_key)} probe (${sensorId})` : '');
  const [notes, setNotes] = useState('');
  const [assignee, setAssignee] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const staff = snap.profiles.filter((p) => p.role !== 'viewer');

  async function save() {
    try {
      await source.createMaintenanceTask(user, { sensor_id: sensorId, title, notes, assigned_to: assignee || null });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Dialog open onClose={onClose} title={`New maintenance task: ${sensorId}`}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="t-title" className="block text-xs">Title</Label>
          <Input id="t-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="t-notes" className="block text-xs">Notes</Label>
          <textarea id="t-notes" rows={2} className="w-full rounded-md border border-input bg-card p-2 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="t-assign" className="block text-xs">Assign to</Label>
          <Select id="t-assign" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {staff.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name} ({p.role})</option>
            ))}
          </Select>
        </div>
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={!title.trim()}>Create task</Button>
        </div>
      </div>
    </Dialog>
  );
}

function MaintenanceTasks() {
  const snap = useSnapshot();
  const { source, user } = useData();
  const me = useUser();
  const staff = canOperate(user);
  const [closing, setClosing] = useState<string | null>(null);
  const [calibrated, setCalibrated] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const who = (id: string | null) => snap.profiles.find((p) => p.id === id)?.full_name ?? (id ? id : 'Unassigned');
  const tasks = snap.maintenanceTasks;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Maintenance tasks</CardTitle>
          <CardDescription>Create a task from a sensor row. Closing a task can mark the probe as calibrated, which resets its calibration date and health.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No maintenance tasks yet.</p>
        ) : (
          <Table>
            <THead>
              <TR><TH>Task</TH><TH>Sensor</TH><TH>Assigned to</TH><TH>Status</TH><TH>Created</TH>{staff && <TH />}</TR>
            </THead>
            <TBody>
              {tasks.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <div className="font-medium">{t.title}</div>
                    {t.notes && <div className="text-xs text-muted-foreground">{t.notes}</div>}
                  </TD>
                  <TD className="font-mono text-xs">{t.sensor_id}</TD>
                  <TD>{who(t.assigned_to)}</TD>
                  <TD>
                    {t.status === 'open' ? (
                      <Badge className="border-amber-700/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100">Open</Badge>
                    ) : (
                      <Badge className="text-muted-foreground">Done {t.closed_at ? fmtDate(t.closed_at) : ''} · {who(t.closed_by)}</Badge>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap text-xs">{fmtDate(t.created_at)} · {who(t.created_by)}</TD>
                  {staff && (
                    <TD>
                      {t.status === 'open' && (
                        <Button size="sm" variant="outline" onClick={() => { setClosing(t.id); setCalibrated(true); setErr(null); }}>
                          Close…
                        </Button>
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <Dialog open={!!closing} onClose={() => setClosing(null)} title="Close maintenance task">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={calibrated} onChange={(e) => setCalibrated(e.target.checked)} className="mt-1" />
            The probe was calibrated or cleaned: reset its calibration date, set health to OK and clear the maintenance flag.
          </label>
          {err && <p role="alert" className="mt-2 text-sm text-destructive">{err}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
            <Button
              onClick={async () => {
                try {
                  await source.closeMaintenanceTask(me, closing!, calibrated);
                  setClosing(null);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Close task
            </Button>
          </div>
        </Dialog>
      </CardContent>
    </Card>
  );
}

import { useEffect, useState } from 'react';
import { Activity, BatteryLow, Droplets, RotateCcw, WifiOff, Waves } from 'lucide-react';
import { formatLimit } from '@shared/limits.ts';
import type { AuditEntry, Parameter, RiskTier, Settings } from '@shared/types.ts';
import { useData, useSnapshot, useUser } from '@/data/DataProvider';
import { zoneSummaries } from '@/data/selectors';
import type { SimAction } from '@/data/source';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/form';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LakeMap } from '@/components/map/LakeMap';
import { PageHeader } from '@/features/layout/AppShell';
import { fmtDateTime } from '@/lib/time';
import { cn } from '@/lib/utils';

const TABS = ['Simulator', 'Parameters', 'Thresholds', 'Water body', 'Audit log'] as const;
type Tab = (typeof TABS)[number];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('Simulator');
  return (
    <div className="pb-6">
      <PageHeader title="Settings" description="Admin only. Every change is written to the audit log." />
      <div role="tablist" aria-label="Settings sections" className="mx-4 flex gap-1 overflow-x-auto border-b md:mx-6">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground')}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="px-4 pt-3 md:px-6" role="tabpanel">
        {tab === 'Simulator' && <SimulatorPanel />}
        {tab === 'Parameters' && <ParametersPanel />}
        {tab === 'Thresholds' && <ThresholdsPanel />}
        {tab === 'Water body' && <WaterBodyPanel />}
        {tab === 'Audit log' && <AuditPanel />}
      </div>
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  return { busy, msg, run };
}

function Feedback({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <p role="status" className={cn('text-sm', msg.ok ? 'text-green-800 dark:text-green-300' : 'text-destructive')}>
      {msg.text}
    </p>
  );
}

function SimulatorPanel() {
  const { source } = useData();
  const user = useUser();
  const snap = useSnapshot();
  const { busy, msg, run } = useAction();
  const [driftParam, setDriftParam] = useState('do');
  const [plumeZone, setPlumeZone] = useState('B');
  const sim = snap.sim;
  const act = (a: SimAction, ok: string) => run(() => source.simControl(user, a), ok);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Fault and event injection</CardTitle>
            <CardDescription>Exercise the system without hardware. Effects show on the live map, dashboard and analytics.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="drift" className="block text-xs">Boat probe</Label>
              <Select id="drift" value={driftParam} onChange={(e) => setDriftParam(e.target.value)}>
                {['ph', 'do', 'turbidity', 'conductivity', 'tds'].map((k) => (
                  <option key={k} value={k}>{snap.parameters.find((p) => p.key === k)?.name}</option>
                ))}
              </Select>
            </div>
            <Button variant="outline" disabled={busy} onClick={() => act({ action: 'inject_drift', parameter_key: driftParam }, `Drift injected on the boat ${driftParam} probe; it ramps over 10 simulated minutes.`)}>
              <Activity className="h-4 w-4" aria-hidden /> Inject sensor drift
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="plume" className="block text-xs">Zone</Label>
              <Select id="plume" value={plumeZone} onChange={(e) => setPlumeZone(e.target.value)}>
                {snap.zones.map((z) => (
                  <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
                ))}
              </Select>
            </div>
            <Button variant="outline" disabled={busy} onClick={() => act({ action: 'inject_plume', zone_id: plumeZone }, `Pollution plume injected in zone ${plumeZone} for 30 simulated minutes.`)}>
              <Droplets className="h-4 w-4" aria-hidden /> Inject pollution plume
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => act({ action: 'drop_link' }, 'Boat link dropped for 90 s.')}>
              <WifiOff className="h-4 w-4" aria-hidden /> Drop link for 90 s
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => act({ action: 'drain_battery' }, 'Battery drained below the return level; the onboard failsafe takes over.')}>
              <BatteryLow className="h-4 w-4" aria-hidden /> Drain battery
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 border-t pt-3">
            <Button variant="secondary" disabled={busy} onClick={() => act({ action: 'clear_injections' }, 'Injected faults cleared.')}>
              Clear injections
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => act({ action: 'reset' }, 'Simulator reset to the seeded demo state.')}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Reset simulator
            </Button>
          </div>
          <Feedback msg={msg} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Simulator state</CardTitle>
            <CardDescription>Boat telemetry every 3 s, stations every 5 simulated minutes.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {sim ? (
            <>
              <dl className="grid grid-cols-2 gap-2">
                <dt className="text-muted-foreground">Phase</dt>
                <dd className="font-medium capitalize">{sim.phase}</dd>
                <dt className="text-muted-foreground">Drift</dt>
                <dd>{sim.injections.drift ? `${sim.injections.drift.parameter_key} since ${fmtDateTime(sim.injections.drift.started_at)}` : 'None'}</dd>
                <dt className="text-muted-foreground">Plume</dt>
                <dd>{sim.injections.plume ? `Zone ${sim.injections.plume.zone_id} since ${fmtDateTime(sim.injections.plume.started_at)}` : 'None'}</dd>
                <dt className="text-muted-foreground">Link drop</dt>
                <dd>{sim.injections.link_down_until && sim.injections.link_down_until > Date.now() ? `Until ${fmtDateTime(sim.injections.link_down_until)}` : 'None'}</dd>
              </dl>
              {sim.phase_reason && <p className="rounded bg-muted p-2 text-xs">{sim.phase_reason}</p>}
              {source.kind === 'demo' && (
                <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                  <div>
                    <Label htmlFor="speed" className="block text-xs">Simulation speed</Label>
                    <Select id="speed" value={sim.speed_factor} disabled={busy} onChange={(e) => act({ action: 'set_speed', speed_factor: Number(e.target.value) }, `Simulation speed set to ×${e.target.value}.`)}>
                      {[1, 5, 10, 20].map((n) => (
                        <option key={n} value={n}>×{n}{n === 1 ? ' (real time, 0.8 m/s)' : ''}</option>
                      ))}
                    </Select>
                  </div>
                  <p className="text-xs text-muted-foreground">Speeds up boat movement and station reporting so demos don’t take an hour.</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">No simulator running for this data source.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ParametersPanel() {
  const { source } = useData();
  const user = useUser();
  const snap = useSnapshot();
  const { busy, msg, run } = useAction();
  const [edits, setEdits] = useState<Record<string, Partial<Parameter>>>({});
  const val = (p: Parameter, k: keyof Parameter) => (edits[p.id]?.[k] ?? p[k]) as string | number | boolean | null;
  const setVal = (p: Parameter, k: keyof Parameter, v: unknown) => setEdits((e) => ({ ...e, [p.id]: { ...e[p.id], [k]: v } }));
  const num = (s: string) => (s.trim() === '' ? null : Number(s));

  async function save(p: Parameter) {
    const patch = edits[p.id];
    if (!patch) return;
    const merged = { ...p, ...patch };
    if (merged.limit_type === 'range' && (merged.limit_low == null || merged.limit_high == null || merged.limit_low >= merged.limit_high)) {
      throw new Error('A range limit needs a low value below the high value.');
    }
    if (merged.limit_type === 'max' && merged.limit_high == null) throw new Error('A max limit needs a high value.');
    if (merged.limit_type === 'min' && merged.limit_low == null) throw new Error('A min limit needs a low value.');
    await source.updateParameter(user, p.id, patch);
    setEdits((e) => {
      const { [p.id]: _drop, ...rest } = e;
      void _drop;
      return rest;
    });
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Parameters and safe limits</CardTitle>
          <CardDescription>
            Defaults are a starting point. Check every limit against the standard that applies to this water body, for example BIS IS 10500 for drinking
            water or CPCB designated-best-use criteria for surface water.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <THead>
            <TR>
              <TH>Parameter</TH>
              <TH>Unit</TH>
              <TH>Limit type</TH>
              <TH>Low</TH>
              <TH>High</TH>
              <TH>Hazard weight</TH>
              <TH>Enabled</TH>
              <TH>Current</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {snap.parameters.map((p) => (
              <TR key={p.id}>
                <TD className="font-medium">{p.name}</TD>
                <TD>
                  <Input aria-label={`${p.name} unit`} className="h-8 w-24" value={String(val(p, 'unit'))} onChange={(e) => setVal(p, 'unit', e.target.value)} />
                </TD>
                <TD>
                  <Select aria-label={`${p.name} limit type`} value={String(val(p, 'limit_type'))} onChange={(e) => setVal(p, 'limit_type', e.target.value)}>
                    <option value="max">max</option>
                    <option value="min">min</option>
                    <option value="range">range</option>
                    <option value="none">trend only</option>
                  </Select>
                </TD>
                <TD>
                  <Input aria-label={`${p.name} low limit`} type="number" step="any" className="h-8 w-20" value={val(p, 'limit_low') == null ? '' : String(val(p, 'limit_low'))} onChange={(e) => setVal(p, 'limit_low', num(e.target.value))} />
                </TD>
                <TD>
                  <Input aria-label={`${p.name} high limit`} type="number" step="any" className="h-8 w-20" value={val(p, 'limit_high') == null ? '' : String(val(p, 'limit_high'))} onChange={(e) => setVal(p, 'limit_high', num(e.target.value))} />
                </TD>
                <TD>
                  <Input aria-label={`${p.name} hazard weight`} type="number" step="0.1" min="0" className="h-8 w-20" value={String(val(p, 'hazard_weight'))} onChange={(e) => setVal(p, 'hazard_weight', Number(e.target.value))} />
                </TD>
                <TD>
                  <input aria-label={`${p.name} enabled`} type="checkbox" checked={Boolean(val(p, 'enabled'))} onChange={(e) => setVal(p, 'enabled', e.target.checked)} />
                </TD>
                <TD className="whitespace-nowrap text-xs text-muted-foreground">{formatLimit(p)}</TD>
                <TD>
                  <Button size="sm" disabled={busy || !edits[p.id]} onClick={() => run(() => save(p), `${p.name} saved.`)}>
                    Save
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
        <div className="mt-2">
          <Feedback msg={msg} />
        </div>
      </CardContent>
    </Card>
  );
}

function ThresholdsPanel() {
  const { source } = useData();
  const user = useUser();
  const snap = useSnapshot();
  const { busy, msg, run } = useAction();
  const [form, setForm] = useState<Settings>(snap.settings);
  useEffect(() => setForm(snap.settings), [snap.settings]);

  const field = (key: keyof Settings, label: string, opts: { step?: string; min?: number; max?: number; unit?: string } = {}) => (
    <div>
      <Label htmlFor={`set-${key}`} className="block text-xs">{label}</Label>
      <div className="flex items-center gap-1">
        <Input id={`set-${key}`} type="number" className="h-9 w-28" step={opts.step ?? 'any'} min={opts.min} max={opts.max} value={String(form[key])} onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))} />
        {opts.unit && <span className="text-xs text-muted-foreground">{opts.unit}</span>}
      </div>
    </div>
  );

  function validate(): Settings {
    const c = form.tier_cutoffs;
    if (!(c.medium < c.high && c.high < c.critical)) throw new Error('Tier cut-offs must increase: Medium < High < Critical.');
    if (form.trust_threshold <= 0 || form.trust_threshold >= 1) throw new Error('Trust threshold must be between 0 and 1.');
    return form;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Thresholds</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {field('trust_threshold', 'Trust threshold', { step: '0.05', min: 0, max: 1 })}
          {field('low_battery_return_pct', 'Low-battery return level', { min: 5, max: 90, unit: '%' })}
          {field('link_loss_timeout_s', 'Link-loss timeout', { min: 5, unit: 's' })}
          {field('survey_interval_days', 'Survey interval', { min: 1, unit: 'days' })}
          {field('near_limit_pct', '"Near limit" band', { min: 1, max: 50, unit: '%' })}
          {field('crosscheck_distance_m', 'Cross-check distance', { min: 1, unit: 'm' })}
          {field('crosscheck_tolerance_pct', 'Cross-check tolerance', { min: 1, unit: '%' })}
        </div>
        <fieldset className="rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Risk-tier cut-offs (R ≥ value)</legend>
          <div className="flex flex-wrap gap-3">
            {(['medium', 'high', 'critical'] as const).map((k) => (
              <div key={k}>
                <Label htmlFor={`tier-${k}`} className="block text-xs capitalize">{k}</Label>
                <Input
                  id={`tier-${k}`}
                  type="number"
                  step="0.05"
                  min={0}
                  max={1}
                  className="h-9 w-24"
                  value={form.tier_cutoffs[k]}
                  onChange={(e) => setForm((f) => ({ ...f, tier_cutoffs: { ...f.tier_cutoffs, [k]: Number(e.target.value) } }))}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Seeded zone scores keep the tier they were computed with; new scores use these cut-offs.</p>
        </fieldset>
        <div className="flex items-center gap-3">
          <Button disabled={busy} onClick={() => run(() => source.updateSettings(user, validate()), 'Thresholds saved.')}>Save thresholds</Button>
          <Feedback msg={msg} />
        </div>
      </CardContent>
    </Card>
  );
}

function WaterBodyPanel() {
  const snap = useSnapshot();
  const tiers = Object.fromEntries(zoneSummaries(snap).map((s) => [s.zone.id, s.score?.risk_tier])) as Record<string, RiskTier | undefined>;
  const wb = snap.waterBody;
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardContent className="pt-4">
          <div className="h-96 overflow-hidden rounded-md border">
            <LakeMap snap={snap} tiers={tiers} className="h-full w-full" layers={{ route: false, trail: false, samples: false }} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Waves className="h-4 w-4" aria-hidden /> {wb?.name}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>Type: {wb?.type}</p>
          <p>Home / dock: {wb?.home_point.map((v) => v.toFixed(5)).join(', ')}</p>
          <p>Geofence: {wb?.geofence.length} vertices</p>
          <ul className="list-disc pl-5">
            {snap.zones.map((z) => (
              <li key={z.id}>
                Zone {z.code}: {z.name}
              </li>
            ))}
          </ul>
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            Drawing and editing zones, the geofence and the home point on the map is scheduled with the Phase 3 safety work, so geofence changes ship together with
            server-side command validation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function AuditPanel() {
  const { source } = useData();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const load = () => void source.listAudit(200).then(setRows);
  useEffect(load, [source]);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>Settings changes and simulator actions. Boat commands, mission approvals and alert actions join this log in Phases 2–3.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {!rows ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries yet.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>User</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>Details</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.ts)}</TD>
                  <TD>{r.user_id}</TD>
                  <TD className="font-mono text-xs">{r.action}</TD>
                  <TD>
                    {r.entity} {r.entity_id}
                  </TD>
                  <TD className="max-w-xs truncate font-mono text-xs" title={JSON.stringify(r.details)}>
                    {JSON.stringify(r.details)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

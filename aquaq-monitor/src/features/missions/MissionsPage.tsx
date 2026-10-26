import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Info, Play, Rocket, Send, Trash2 } from 'lucide-react';
import { DEFAULT_LEVEL_ENERGY, LEVELS, LEVEL_LABEL, evaluatePlan, routeLengthM } from '@shared/planner.ts';
import type { Mission, MissionStatus, RiskTier, SamplingLevel } from '@shared/types.ts';
import { canOperate, useData, useSnapshot, useUser } from '@/data/DataProvider';
import { zoneSummaries } from '@/data/selectors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Select } from '@/components/ui/form';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { LakeMap } from '@/components/map/LakeMap';
import { PageHeader } from '@/features/layout/AppShell';
import { StartMissionDialog } from '@/features/control/StartMissionDialog';
import { fmtDateTime } from '@/lib/time';
import { cn } from '@/lib/utils';

export const SOLVER_LABEL: Record<string, string> = {
  quantum_qaoa: 'Quantum (QAOA)',
  quantum_annealer: 'Quantum (annealer)',
  classical_fallback: 'Classical fallback',
  mock: 'Mock planner',
};

/** Plain description of the solver, without claims about quantum advantage. */
const SOLVER_NOTE: Record<string, string> = {
  quantum_qaoa: 'Solved by the planner service with QAOA on a quantum backend or simulator.',
  quantum_annealer: 'Solved by the planner service with quantum annealing.',
  classical_fallback: 'The planner service used its classical fallback solver.',
  mock: 'v1 mock planner: tries every level combination (greedy above 8 zones). No quantum computation.',
};

const STATUS_STYLE: Record<MissionStatus, string> = {
  proposed: 'border-sky-700/30 bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-100',
  approved: 'border-indigo-700/30 bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100',
  sent: 'border-indigo-700/30 bg-indigo-50 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100',
  running: 'border-green-700/30 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100',
  paused: 'border-yellow-700/30 bg-yellow-50 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-100',
  completed: 'text-muted-foreground',
  aborted: 'text-muted-foreground',
};

const GROUPS: { title: string; statuses: MissionStatus[] }[] = [
  { title: 'Proposed: waiting for approval', statuses: ['proposed'] },
  { title: 'Approved and on the boat', statuses: ['approved', 'sent'] },
  { title: 'Running', statuses: ['running', 'paused'] },
  { title: 'Past missions', statuses: ['completed', 'aborted'] },
];

export function MissionsPage() {
  const snap = useSnapshot();
  const { user } = useData();
  const [params] = useSearchParams();
  const focus = params.get('id');
  const staff = canOperate(user);
  // Kept here, not in the card: a card remounts when its mission moves to another group.
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const sorted = [...snap.missions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  useEffect(() => {
    if (focus) document.getElementById(`mission-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  return (
    <div className="pb-6">
      <PageHeader title="Missions" description="The planner proposes; an operator reviews and approves. Plans are never sent to the boat automatically." />
      <div className="space-y-4 px-4 md:px-6">
        {staff && <PlanPanel />}
        {GROUPS.map((g) => {
          const list = sorted.filter((m) => g.statuses.includes(m.status));
          if (!list.length) return null;
          return (
            <section key={g.title} aria-label={g.title}>
              <h2 className="mb-2 text-base font-semibold">{g.title}</h2>
              <div className="space-y-3">
                {list.map((m) => (
                  <MissionCard
                    key={m.id}
                    mission={m}
                    expanded={m.status === 'proposed' || m.id === focus || ['approved', 'sent', 'running', 'paused'].includes(m.status)}
                    highlighted={m.id === focus}
                    err={errors[m.id] ?? null}
                    setErr={(e) => setErrors((x) => ({ ...x, [m.id]: e }))}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function PlanPanel() {
  const snap = useSnapshot();
  const { source } = useData();
  const user = useUser();
  const [budget, setBudget] = useState(snap.settings.energy_budget);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const plannerLabel = snap.settings.planner_mode === 'remote' && snap.settings.planner_url ? `planner service (${snap.settings.planner_url})` : 'mock planner';

  async function plan() {
    setBusy(true);
    setMsg(null);
    try {
      const id = await source.planMission(user, { kind: 'manual', energy_budget: budget });
      setMsg({ ok: true, text: `Plan ${id} proposed. Review it below before approving.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 pt-4">
        <div>
          <Label htmlFor="budget" className="block text-xs">Energy budget (units)</Label>
          <Input id="budget" type="number" min={1} step={1} className="h-10 w-28" value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
        </div>
        <Button onClick={() => void plan()} disabled={busy || !(budget > 0)}>
          {busy ? 'Planning…' : 'Plan next mission'}
        </Button>
        <p className="text-xs text-muted-foreground">Uses the latest zone scores and the {plannerLabel}.</p>
        {msg && (
          <p role="status" className={cn('w-full text-sm', msg.ok ? 'text-green-800 dark:text-green-300' : 'text-destructive')}>
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MissionCard({
  mission: m,
  expanded,
  highlighted,
  err,
  setErr,
}: {
  mission: Mission;
  expanded: boolean;
  highlighted: boolean;
  err: string | null;
  setErr: (e: string | null) => void;
}) {
  const snap = useSnapshot();
  const { source, user } = useData();
  const me = useUser();
  const staff = canOperate(user);
  const [open, setOpen] = useState(expanded);
  const [startOpen, setStartOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const zones = snap.missionZones.filter((z) => z.mission_id === m.id).sort((a, b) => a.zone_id.localeCompare(b.zone_id));
  const wps = snap.waypoints.filter((w) => w.mission_id === m.id).sort((a, b) => a.seq - b.seq);
  const ev = evaluatePlan(zones, DEFAULT_LEVEL_ENERGY, m.energy_budget);
  const counts = LEVELS.map((l) => [l, zones.filter((z) => z.level === l).length] as const);
  const lengthM = snap.waterBody && wps.length ? routeLengthM(snap.waterBody.home_point, wps) : 0;
  const tiers = Object.fromEntries(zoneSummaries(snap).map((s) => [s.zone.id, s.score?.risk_tier])) as Record<string, RiskTier | undefined>;
  const who = (id: string | null) => snap.profiles.find((p) => p.id === id || p.email === id)?.full_name ?? id;
  const boatBusy = snap.boats[0]?.mission_id != null && snap.boats[0]?.mission_id !== m.id;
  const reached = wps.filter((w) => w.status === 'reached').length;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id={`mission-${m.id}`} className={cn(highlighted && 'ring-2 ring-ring')}>
      <CardHeader>
        <div>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {m.id} · {m.name}
            {m.kind === 'early' && (
              <Badge className="border-orange-700/30 bg-orange-50 text-orange-900 dark:bg-orange-950 dark:text-orange-100">
                <Rocket className="h-3 w-3" aria-hidden /> Early mission
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Created {fmtDateTime(m.created_at)} by {m.created_by}
            {m.approved_at && ` · approved by ${who(m.approved_by)} at ${fmtDateTime(m.approved_at)}`}
            {m.started_at && ` · started ${fmtDateTime(m.started_at)}`}
            {m.ended_at && ` · ended ${fmtDateTime(m.ended_at)}`}
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge className={cn('capitalize', STATUS_STYLE[m.status])}>{m.status}</Badge>
          <Badge title={SOLVER_NOTE[m.solver]}>Solver: {SOLVER_LABEL[m.solver]}</Badge>
          <Badge className={ev.overBudget ? 'border-red-700/40 bg-red-50 text-red-900' : ''}>
            Energy {ev.energy} / {m.energy_budget}
          </Badge>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide details' : 'Show details'}
          </Button>
        </div>
      </CardHeader>

      {open && (
        <CardContent>
          <div className="grid gap-3 lg:grid-cols-5">
            <div className="h-72 overflow-hidden rounded-md border lg:col-span-2">
              <LakeMap snap={snap} tiers={tiers} routeMissionId={m.id} className="h-full w-full" layers={{ trail: false, samples: false, heatmap: false }} />
            </div>
            <div className="lg:col-span-3">
              <Table>
                <THead>
                  <TR>
                    <TH>Zone</TH>
                    <TH>R</TH>
                    <TH>T</TH>
                    <TH>Level</TH>
                    <TH>Energy</TH>
                    <TH>Reason</TH>
                  </TR>
                </THead>
                <TBody>
                  {zones.map((z) => (
                    <TR key={z.zone_id}>
                      <TD className="font-medium">{z.zone_id}</TD>
                      <TD className="tabular-nums">{z.risk_R.toFixed(2)}</TD>
                      <TD className="tabular-nums">{z.trust_T.toFixed(2)}</TD>
                      <TD>
                        {m.status === 'proposed' && staff ? (
                          <Select
                            aria-label={`Sampling level for zone ${z.zone_id}`}
                            value={z.level}
                            disabled={busy}
                            onChange={(e) => void run(() => source.setMissionZoneLevel(me, m.id, z.zone_id, e.target.value as SamplingLevel))}
                          >
                            {LEVELS.map((l) => (
                              <option key={l} value={l}>
                                {LEVEL_LABEL[l]} ({DEFAULT_LEVEL_ENERGY[l]})
                              </option>
                            ))}
                          </Select>
                        ) : (
                          LEVEL_LABEL[z.level]
                        )}
                      </TD>
                      <TD className="tabular-nums">{z.energy}</TD>
                      <TD className="text-sm">{z.reason}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>

              <div className="mt-3 grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">Solver</div>
                  <div className="font-medium">{SOLVER_LABEL[m.solver]}</div>
                  <div className="text-xs text-muted-foreground">{SOLVER_NOTE[m.solver]}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Energy planned vs budget</div>
                  <div className={cn('font-medium tabular-nums', ev.overBudget && 'text-red-700 dark:text-red-300')}>
                    {ev.energy} of {m.energy_budget} units · total value {ev.objective}
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-muted" role="progressbar" aria-label="Energy planned" aria-valuenow={ev.energy} aria-valuemin={0} aria-valuemax={m.energy_budget}>
                    <div className={cn('h-2 rounded-full', ev.overBudget ? 'bg-red-600' : 'bg-primary')} style={{ width: `${Math.min(100, (ev.energy / m.energy_budget) * 100)}%` }} />
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Zones per level</div>
                  <div>{counts.filter(([, n]) => n > 0).map(([l, n]) => `${LEVEL_LABEL[l]}: ${n}`).join(' · ')}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Route</div>
                  <div>
                    {wps.length} waypoints · {(lengthM / 1000).toFixed(2)} km · about {Math.round(lengthM / 0.8 / 60)} min at 0.8 m/s
                    {(m.status === 'running' || m.status === 'paused' || m.status === 'completed') && ` · ${reached} reached`}
                  </div>
                </div>
              </div>

              {m.note && (
                <p className="mt-2 flex items-start gap-2 rounded-md bg-muted p-2 text-sm">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {m.note}
                </p>
              )}

              {staff && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {m.status === 'proposed' && (
                    <>
                      <Button onClick={() => void run(() => source.approveMission(me, m.id))} disabled={busy || ev.overBudget}>
                        <Send className="h-4 w-4" aria-hidden /> Approve and send to boat
                      </Button>
                      {ev.overBudget && (
                        <span className="inline-flex items-center gap-1 text-sm text-red-800 dark:text-red-200">
                          <AlertTriangle className="h-4 w-4" aria-hidden /> Over budget by {ev.energy - m.energy_budget}: lower some levels to approve.
                        </span>
                      )}
                    </>
                  )}
                  {m.status === 'approved' && (
                    <Button onClick={() => void run(() => source.approveMission(me, m.id))} disabled={busy}>
                      <Send className="h-4 w-4" aria-hidden /> Send to boat
                    </Button>
                  )}
                  {m.status === 'sent' && (
                    <Button onClick={() => setStartOpen(true)} disabled={busy || boatBusy}>
                      <Play className="h-4 w-4" aria-hidden /> Start mission…
                    </Button>
                  )}
                  {(m.status === 'proposed' || m.status === 'approved') && (
                    <Button variant="outline" onClick={() => void run(() => source.discardMission(me, m.id))} disabled={busy}>
                      <Trash2 className="h-4 w-4" aria-hidden /> Discard
                    </Button>
                  )}
                  {m.status === 'sent' && boatBusy && <span className="text-sm text-muted-foreground">The boat is on mission {snap.boats[0].mission_id}; it can start this one once that ends.</span>}
                </div>
              )}
              {err && (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {err}
                </p>
              )}
            </div>
          </div>
          {startOpen && <StartMissionDialog missionId={m.id} open={startOpen} onClose={() => setStartOpen(false)} />}
        </CardContent>
      )}
    </Card>
  );
}

import { useMemo, useState } from 'react';
import { Battery, Compass, Gauge, Layers, Radio, ShieldAlert } from 'lucide-react';
import { limitStatus } from '@shared/limits.ts';
import type { Reading, RiskTier } from '@shared/types.ts';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { activeMission, latestSurvey, secondsSince, zoneSummaries } from '@/data/selectors';
import { DEFAULT_LAYERS, LakeMap, MapLegend, type MapLayers } from '@/components/map/LakeMap';
import { Freshness, StaleDim } from '@/components/Freshness';
import { LimitBadge } from '@/components/status';
import { Select } from '@/components/ui/form';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';

const LAYER_LABELS: [keyof MapLayers, string][] = [
  ['zones', 'Risk zones'],
  ['heatmap', 'Heatmap'],
  ['samples', 'Sampling points'],
  ['route', 'Route'],
  ['trail', 'Trail (30 min)'],
  ['geofence', 'Geofence'],
  ['stations', 'Stations'],
];

export function LiveMapPage() {
  const snap = useSnapshot();
  const now = useNow();
  const [layers, setLayers] = useState<MapLayers>({ ...DEFAULT_LAYERS });
  const [heatParam, setHeatParam] = useState('turbidity');
  const [showLayers, setShowLayers] = useState(false);
  const survey = latestSurvey(snap);
  const surveyReadings = useReadings(survey ? { surveyIds: [survey.id], sourceTypes: ['boat'] } : null);
  const tiers = Object.fromEntries(zoneSummaries(snap).map((s) => [s.zone.id, s.score?.risk_tier])) as Record<string, RiskTier | undefined>;
  const samples = useMemo(() => [...surveyReadings.data, ...thinLive(snap.recentReadings)], [surveyReadings.data, snap.recentReadings]);

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] flex-col md:h-[calc(100dvh-2rem)] lg:flex-row short:h-[100dvh] short:flex-row">
      <div className="relative min-h-[50%] flex-1">
        <LakeMap snap={snap} tiers={tiers} layers={layers} sampleReadings={samples} heatParam={heatParam} className="absolute inset-0" />

        <div className="absolute right-2 top-2 z-[1000] flex flex-col items-end gap-2">
          <button
            onClick={() => setShowLayers((v) => !v)}
            aria-expanded={showLayers}
            aria-controls="layer-panel"
            className="inline-flex items-center gap-1 rounded-md border bg-card px-3 py-2 text-sm font-medium shadow"
          >
            <Layers className="h-4 w-4" aria-hidden /> Layers
          </button>
          {showLayers && (
            <fieldset id="layer-panel" className="w-56 space-y-1 rounded-md border bg-card p-3 text-sm shadow">
              <legend className="sr-only">Map layers</legend>
              {LAYER_LABELS.map(([k, label]) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((l) => ({ ...l, [k]: e.target.checked }))} />
                  {label}
                </label>
              ))}
              {layers.heatmap && (
                <label className="mt-1 block text-xs">
                  Heatmap parameter
                  <Select className="mt-1 w-full" value={heatParam} onChange={(e) => setHeatParam(e.target.value)}>
                    {snap.parameters
                      .filter((p) => p.enabled && p.limit_type !== 'none')
                      .map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.name}
                        </option>
                      ))}
                  </Select>
                </label>
              )}
              <div className="border-t pt-2">
                <MapLegend />
              </div>
            </fieldset>
          )}
        </div>
      </div>

      <BoatPanel now={now} />
    </div>
  );
}

function BoatPanel({ now }: { now: number }) {
  const snap = useSnapshot();
  const boat = snap.boats[0];
  const mission = activeMission(snap);
  if (!boat) return null;
  const wps = snap.waypoints.filter((w) => w.mission_id === mission?.id);
  const reached = wps.filter((w) => w.status === 'reached').length;
  const progress = wps.length ? Math.round((reached / wps.length) * 100) : 0;
  const age = secondsSince(boat.last_seen, now);
  const linkLost = age > snap.settings.link_loss_timeout_s;
  const current = wps.find((w) => w.seq === boat.waypoint_seq);
  const boatReadings = snap.latestBySource[boat.id] ?? {};
  const energyUsed = mission ? Math.min(mission.energy_planned, (reached / Math.max(1, wps.length)) * mission.energy_planned) : 0;

  return (
    <aside
      aria-label="Boat panel"
      className="max-h-[50%] shrink-0 overflow-y-auto border-t bg-card p-4 lg:max-h-none lg:w-96 lg:border-l lg:border-t-0 short:max-h-none short:w-72 short:border-l short:border-t-0 short:p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{boat.name}</h2>
          <Freshness ts={boat.last_seen} />
        </div>
        <span className={cn('rounded-md px-2 py-1 text-sm font-semibold', boat.mode === 'AUTO' ? 'bg-accent text-accent-foreground' : 'bg-secondary')}>{boat.mode}</span>
      </div>

      {linkLost && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-red-700/40 bg-red-50 p-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div>
            <div className="font-semibold">Link lost. Boat following onboard failsafe.</div>
            <div className="text-xs">No telemetry for {Math.round(age)} s. Controls are disabled until the link returns.</div>
          </div>
        </div>
      )}
      {snap.sim?.phase_reason && <p className="mt-2 rounded-md bg-muted p-2 text-xs">{snap.sim.phase_reason}</p>}

      <StaleDim ts={boat.last_seen}>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <Stat icon={Battery} label="Battery" value={`${boat.battery_pct.toFixed(0)}%`} warn={boat.battery_pct < snap.settings.low_battery_return_pct} />
          <Stat icon={Gauge} label="Speed" value={`${boat.speed_mps.toFixed(1)} m/s`} />
          <Stat icon={Compass} label="Heading" value={`${Math.round(boat.heading_deg)}°`} />
          <Stat icon={Radio} label="Link" value={linkLost ? 'Lost' : boat.link_type} warn={linkLost} />
        </dl>

        {mission && (
          <div className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">Mission</span>
              <span className="text-right font-medium">
                {mission.id} <span className="text-xs text-muted-foreground">({mission.solver === 'mock' ? 'mock planner' : mission.solver})</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Current waypoint</span>
              <span className="font-medium">{current ? `${current.seq} of ${wps.length} · ${current.action.replace('_', ' ')}` : '–'}</span>
            </div>
            <Bar label="Progress" value={progress} text={`${reached}/${wps.length} waypoints`} />
            <Bar
              label="Energy used vs budget (est.)"
              value={(energyUsed / mission.energy_budget) * 100}
              text={`${energyUsed.toFixed(1)} of ${mission.energy_budget} units (planned ${mission.energy_planned})`}
            />
          </div>
        )}

        <h3 className="mt-4 text-sm font-semibold">Latest boat readings</h3>
        <ul className="mt-1 divide-y text-sm">
          {snap.parameters
            .filter((p) => boatReadings[p.key])
            .map((p) => {
              const r = boatReadings[p.key];
              return (
                <li key={p.key} className="flex items-center justify-between gap-2 py-1.5">
                  <span>{p.name}</span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums font-medium">
                      {r.value} <span className="text-xs text-muted-foreground">{p.unit}</span>
                    </span>
                    <LimitBadge status={limitStatus(r.value, p, snap.settings.near_limit_pct)} />
                  </span>
                </li>
              );
            })}
        </ul>
      </StaleDim>

      <div className="mt-4 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        Boat controls (start/pause, return home, go to point, manual mode and the emergency stop) are built in Phase 3 with server-side command
        validation. The boat's own geofence, obstacle avoidance, low-battery return and link-loss failsafe always stay active.
      </div>
    </aside>
  );
}

/** Live boat telemetry arrives every 3 s; keep one sampling point per 30 s so the map stays readable. */
function thinLive(readings: Reading[]): Reading[] {
  const keep = new Set<string>();
  const out: Reading[] = [];
  for (const r of readings) {
    if (r.source_type !== 'boat') continue;
    const bucket = Math.floor(new Date(r.ts).getTime() / 30_000);
    const first = !keep.has(`${bucket}`) || keep.has(`${bucket}|${r.ts}`);
    if (first) {
      keep.add(`${bucket}`);
      keep.add(`${bucket}|${r.ts}`);
      out.push(r);
    }
  }
  return out;
}

function Stat({ icon: Icon, label, value, warn }: { icon: typeof Battery; label: string; value: string; warn?: boolean }) {
  return (
    <div className={cn('rounded-md border p-2', warn && 'border-red-700/40 bg-red-50 dark:bg-red-950')}>
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
      </dt>
      <dd className="font-semibold tabular-nums">
        {value}
        {warn && <span className="sr-only"> (warning)</span>}
      </dd>
    </div>
  );
}

function Bar({ label, value, text }: { label: string; value: number; text: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>{text}</span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-2 rounded-full bg-primary" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

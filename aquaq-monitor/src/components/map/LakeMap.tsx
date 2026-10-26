import { useEffect, useMemo, type ReactNode } from 'react';
import { Circle, CircleMarker, MapContainer, Marker, Polygon, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { limitRatio, limitStatus } from '@shared/limits.ts';
import type { LatLon, Parameter, Reading, RiskTier, Zone } from '@shared/types.ts';
import type { Snapshot } from '@/data/source';
import { TIER_COLOR } from '@/components/status';
import { fmtDateTime } from '@/lib/time';

export interface MapLayers {
  zones: boolean;
  geofence: boolean;
  route: boolean;
  trail: boolean;
  boat: boolean;
  stations: boolean;
  samples: boolean;
  heatmap: boolean;
}

export const DEFAULT_LAYERS: MapLayers = {
  zones: true, geofence: true, route: true, trail: true, boat: true, stations: true, samples: true, heatmap: false,
};

export const SAMPLE_COLORS = {
  normal: '#16a34a',
  anomaly: '#dc2626',
  highRisk: '#db2777',
  sampling: '#ea580c',
  confirm: '#7c3aed',
  source: '#facc15',
};

interface Props {
  snap: Snapshot;
  tiers: Record<string, RiskTier | undefined>;
  layers?: Partial<MapLayers>;
  /** Readings drawn as sampling points and used for the heatmap. */
  sampleReadings?: Reading[];
  heatParam?: string;
  className?: string;
  focusZone?: Zone;
  interactive?: boolean;
  onZoneClick?: (zoneId: string) => void;
  children?: ReactNode;
}

function FitBounds({ points }: { points: LatLon[] }) {
  const map = useMap();
  const key = points.length ? `${points[0][0]},${points[0][1]},${points.length}` : '';
  useEffect(() => {
    if (points.length) map.fitBounds(L.latLngBounds(points.map(([a, b]) => L.latLng(a, b))), { padding: [16, 16] });
    // Refit only when the geometry changes, not on every live update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

/** Keeps Leaflet sized correctly when its container changes size (side panels, rotation). */
function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

const boatIcon = (heading: number, stale: boolean) =>
  L.divIcon({
    className: 'aq-icon',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    html: `<svg width="30" height="30" viewBox="0 0 30 30" style="transform:rotate(${heading}deg);opacity:${stale ? 0.45 : 1}" aria-label="Boat, heading ${Math.round(heading)}°"><circle cx="15" cy="15" r="13" fill="#0e7490" stroke="#fff" stroke-width="2"/><path d="M15 5 L21 21 L15 17 L9 21 Z" fill="#fff"/></svg>`,
  });

const stationIcon = L.divIcon({
  className: 'aq-icon',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  html: `<svg width="24" height="24" viewBox="0 0 24 24" aria-label="Fixed station"><rect x="3" y="3" width="18" height="18" rx="3" fill="#1e3a8a" stroke="#fff" stroke-width="2"/><path d="M12 7v10M7 12h10" stroke="#fff" stroke-width="2"/></svg>`,
});

const starIcon = L.divIcon({
  className: 'aq-icon',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  html: `<svg width="28" height="28" viewBox="0 0 24 24" aria-label="Estimated pollution source"><path d="M12 2l3 6.5 7 .8-5.2 4.8 1.5 7L12 17.6 5.7 21.1l1.5-7L2 9.3l7-.8z" fill="${SAMPLE_COLORS.source}" stroke="#78350f" stroke-width="1.5"/></svg>`,
});

const waypointIcon = (seq: number, action: string, reached: boolean, current: boolean) => {
  const color = action === 'confirm_sample' ? SAMPLE_COLORS.confirm : action === 'sample' ? SAMPLE_COLORS.sampling : '#475569';
  const fill = reached ? color : '#ffffff';
  const text = reached ? '#ffffff' : color;
  const ring = current ? `<circle cx="11" cy="11" r="10.5" fill="none" stroke="#0e7490" stroke-width="2" stroke-dasharray="3 2"/>` : '';
  return L.divIcon({
    className: 'aq-icon',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    html: `<svg width="22" height="22" viewBox="0 0 22 22">${ring}<circle cx="11" cy="11" r="8" fill="${fill}" stroke="${color}" stroke-width="2.5"/><text x="11" y="14.5" text-anchor="middle" font-size="9" font-weight="700" fill="${text}" font-family="system-ui">${seq}</text></svg>`,
  });
};

interface SamplePoint {
  key: string;
  pos: LatLon;
  ts: string;
  zone_id: string | null;
  readings: Reading[];
  anomaly: boolean;
  lowTrust: boolean;
}

/** Group readings taken at the same place and time into one sampling point. */
export function groupSamplePoints(readings: Reading[], threshold: number): SamplePoint[] {
  const map = new Map<string, SamplePoint>();
  for (const r of readings) {
    if (r.source_type === 'station') continue;
    const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
    let p = map.get(key);
    if (!p) {
      p = { key, pos: [r.lat, r.lon], ts: r.ts, zone_id: r.zone_id, readings: [], anomaly: false, lowTrust: false };
      map.set(key, p);
    }
    p.readings.push(r);
    if (r.edge_anomaly_flag) {
      p.anomaly = true;
      if (r.trust_T != null && r.trust_T < threshold) p.lowTrust = true;
    }
  }
  return [...map.values()];
}

/** Location of the strongest trusted exceedance, weighted by hazard. */
export function estimateSource(readings: Reading[], params: Parameter[], threshold: number): { pos: LatLon; reading: Reading } | null {
  let best: { score: number; r: Reading } | null = null;
  for (const r of readings) {
    if (!r.edge_anomaly_flag || r.trust_T == null || r.trust_T < threshold || r.source_type === 'station') continue;
    const p = params.find((x) => x.key === r.parameter_key);
    const ratio = p ? limitRatio(r.value, p) : null;
    if (!p || ratio == null || !Number.isFinite(ratio)) continue;
    const score = ratio * p.hazard_weight;
    if (!best || score > best.score) best = { score, r };
  }
  return best ? { pos: [best.r.lat, best.r.lon], reading: best.r } : null;
}

function heatColor(status: string, ratio: number | null): string {
  if (status === 'out') return ratio != null && ratio > 1.5 ? '#991b1b' : '#dc2626';
  if (status === 'near') return '#f59e0b';
  return '#22c55e';
}

export function LakeMap({ snap, tiers, layers: layerProp, sampleReadings = [], heatParam, className, focusZone, interactive = true, onZoneClick, children }: Props) {
  const layers = { ...DEFAULT_LAYERS, ...layerProp };
  const wb = snap.waterBody;
  const boat = snap.boats[0];
  const threshold = snap.settings.trust_threshold;
  const now = Date.now();
  const boatStale = !boat?.last_seen || (now - new Date(boat.last_seen).getTime()) / 1000 > 30;

  const points = useMemo(() => groupSamplePoints(sampleReadings, threshold), [sampleReadings, threshold]);
  const source = useMemo(() => estimateSource(sampleReadings, snap.parameters, threshold), [sampleReadings, snap.parameters, threshold]);
  const heatParamDef = snap.parameters.find((p) => p.key === heatParam);
  const heat = useMemo(
    () => (heatParam ? sampleReadings.filter((r) => r.parameter_key === heatParam && r.source_type !== 'lab') : []),
    [sampleReadings, heatParam],
  );

  if (!wb) return null;
  const fit = focusZone ? focusZone.polygon : wb.boundary;
  const missionWps = snap.waypoints.filter((w) => w.mission_id === boat?.mission_id);
  const currentSeq = boat?.waypoint_seq ?? null;

  return (
    <MapContainer
      className={className}
      center={wb.home_point}
      zoom={16}
      scrollWheelZoom={interactive}
      dragging={interactive}
      zoomControl={interactive}
      doubleClickZoom={interactive}
      attributionControl
    >
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <FitBounds points={fit} />
      <AutoResize />

      <Polygon positions={wb.boundary} pathOptions={{ color: '#0369a1', weight: 2, fillColor: '#7dd3fc', fillOpacity: layers.zones ? 0 : 0.25 }} />

      {layers.zones &&
        snap.zones.map((z) => {
          const tier = tiers[z.id];
          const color = tier ? TIER_COLOR[tier] : '#64748b';
          return (
            <Polygon
              key={z.id}
              positions={z.polygon}
              pathOptions={{ color, weight: focusZone?.id === z.id ? 3 : 1.5, fillColor: color, fillOpacity: focusZone && focusZone.id !== z.id ? 0.08 : 0.28 }}
              eventHandlers={onZoneClick ? { click: () => onZoneClick(z.id) } : undefined}
            >
              <Tooltip sticky>
                Zone {z.code}: {z.name} · {tier ?? 'no score'}
              </Tooltip>
            </Polygon>
          );
        })}

      {layers.geofence && (
        <Polygon positions={wb.geofence} pathOptions={{ color: '#dc2626', weight: 2, dashArray: '8 6', fill: false }}>
          <Tooltip sticky>Geofence</Tooltip>
        </Polygon>
      )}

      {layers.heatmap &&
        heatParamDef &&
        heat.map((r) => {
          const st = limitStatus(r.value, heatParamDef, snap.settings.near_limit_pct);
          const c = heatColor(st, limitRatio(r.value, heatParamDef));
          return (
            <Circle key={`h-${r.id}`} center={[r.lat, r.lon]} radius={14} pathOptions={{ stroke: false, fillColor: c, fillOpacity: 0.35 }}>
              <Tooltip>
                {heatParamDef.name}: {r.value} {heatParamDef.unit} ({st})
              </Tooltip>
            </Circle>
          );
        })}

      {layers.samples &&
        points.map((p) => {
          const highRisk = p.zone_id != null && (tiers[p.zone_id] === 'High' || tiers[p.zone_id] === 'Critical');
          const color = p.anomaly ? SAMPLE_COLORS.anomaly : highRisk ? SAMPLE_COLORS.highRisk : SAMPLE_COLORS.normal;
          const hollow = p.anomaly && p.lowTrust;
          const flagged = p.readings.filter((r) => r.edge_anomaly_flag);
          return (
            <CircleMarker
              key={p.key}
              center={p.pos}
              radius={5}
              pathOptions={{ color, weight: 2, fillColor: color, fillOpacity: hollow ? 0 : 0.85 }}
            >
              <Tooltip>
                <div className="text-xs">
                  <div className="font-semibold">
                    {p.anomaly ? (hollow ? 'Anomaly, low trust (possible sensor fault)' : 'Anomaly') : highRisk ? 'Sample in high-risk zone' : 'Normal sample'}
                  </div>
                  <div>{fmtDateTime(p.ts)}</div>
                  {flagged.map((r) => (
                    <div key={r.id}>
                      {r.parameter_key}: {r.value} (T {r.trust_T ?? '–'})
                    </div>
                  ))}
                </div>
              </Tooltip>
            </CircleMarker>
          );
        })}

      {layers.samples && source && (
        <Marker position={source.pos} icon={starIcon}>
          <Tooltip>
            Estimated pollution source: strongest trusted exceedance ({source.reading.parameter_key} {source.reading.value})
          </Tooltip>
        </Marker>
      )}

      {layers.route && missionWps.length > 0 && (
        <>
          <Polyline positions={[boat.position, ...missionWps.filter((w) => w.seq >= (currentSeq ?? Infinity)).map((w) => [w.lat, w.lon] as LatLon)]} pathOptions={{ color: '#0e7490', weight: 2, dashArray: '4 6' }} />
          <Polyline positions={missionWps.map((w) => [w.lat, w.lon] as LatLon)} pathOptions={{ color: '#475569', weight: 1, opacity: 0.6 }} />
          {missionWps.map((w) => (
            <Marker key={`wp-${w.seq}`} position={[w.lat, w.lon]} icon={waypointIcon(w.seq, w.action, w.status === 'reached', w.seq === currentSeq)}>
              <Tooltip>
                Waypoint {w.seq}: {w.action.replace('_', ' ')} ({w.status})
              </Tooltip>
            </Marker>
          ))}
        </>
      )}

      {layers.trail && snap.boatTrail.length > 1 && (
        <Polyline positions={snap.boatTrail.map((t) => [t.lat, t.lon] as LatLon)} pathOptions={{ color: '#0891b2', weight: 3, opacity: 0.7 }} />
      )}

      {layers.stations &&
        snap.stations.map((s) => (
          <Marker key={s.id} position={s.position} icon={stationIcon}>
            <Tooltip>{s.name}</Tooltip>
          </Marker>
        ))}

      {layers.boat && boat?.position && (
        <Marker position={boat.position} icon={boatIcon(boat.heading_deg, boatStale)} zIndexOffset={1000}>
          <Tooltip>
            {boat.name} · {boat.mode} · {Math.round(boat.battery_pct)}%
          </Tooltip>
        </Marker>
      )}
      {children}
    </MapContainer>
  );
}

export function MapLegend({ compact = false }: { compact?: boolean }) {
  const items: [string, ReactNode][] = [
    ['Normal sample', <Dot key="n" color={SAMPLE_COLORS.normal} />],
    ['Anomaly', <Dot key="a" color={SAMPLE_COLORS.anomaly} />],
    ['Anomaly, low trust', <Dot key="al" color={SAMPLE_COLORS.anomaly} hollow />],
    ['Sample in high-risk zone', <Dot key="h" color={SAMPLE_COLORS.highRisk} />],
    ['Planned sampling point', <Dot key="s" color={SAMPLE_COLORS.sampling} hollow />],
    ['Confirmation sample', <Dot key="c" color={SAMPLE_COLORS.confirm} hollow />],
    ['Estimated source', <span key="st" aria-hidden>★</span>],
    ['Geofence', <span key="g" aria-hidden className="inline-block w-4 border-t-2 border-dashed border-red-600" />],
  ];
  return (
    <ul className={compact ? 'grid grid-cols-2 gap-x-3 gap-y-1 text-xs' : 'space-y-1 text-xs'}>
      {items.map(([label, icon]) => (
        <li key={label} className="flex items-center gap-2">
          <span className="flex w-4 justify-center">{icon}</span>
          {label}
        </li>
      ))}
    </ul>
  );
}

function Dot({ color, hollow }: { color: string; hollow?: boolean }) {
  return <span aria-hidden className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: color, background: hollow ? 'transparent' : color }} />;
}

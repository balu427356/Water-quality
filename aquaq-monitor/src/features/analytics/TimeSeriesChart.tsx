import { useMemo, useState } from 'react';
import { CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import type { SourceType } from '@shared/types.ts';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { ChartCard } from '@/components/ChartCard';
import { Input, Label, Select } from '@/components/ui/form';
import { DAY_MS, fmtDateTime } from '@/lib/time';
import { bucketMean, seriesColor, timeTick } from './chartUtils';

const RANGES = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS, '90d': 90 * DAY_MS } as const;
type RangeKey = keyof typeof RANGES | 'custom';

export function TimeSeriesChart() {
  const snap = useSnapshot();
  const [param, setParam] = useState('turbidity');
  const [zones, setZones] = useState<string[]>(() => snap.zones.map((z) => z.id));
  const [source, setSource] = useState<'all' | SourceType>('all');
  const [range, setRange] = useState<RangeKey>('90d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  // Fix "now" per range choice so the query key is stable between live re-renders.
  const [anchor, setAnchor] = useState(() => Date.now());

  const { from, to } = useMemo(() => {
    if (range === 'custom' && custom.from && custom.to) {
      return { from: new Date(`${custom.from}T00:00:00+05:30`).getTime(), to: new Date(`${custom.to}T23:59:59+05:30`).getTime() };
    }
    const span = range === 'custom' ? RANGES['90d'] : RANGES[range];
    return { from: anchor - span, to: anchor };
  }, [range, custom, anchor]);

  const p = snap.parameters.find((x) => x.key === param);
  const { data, loading, error } = useReadings({
    parameterKeys: [param],
    zoneIds: zones,
    sourceTypes: source === 'all' ? undefined : [source],
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  });

  const span = to - from;
  const bucket = span <= 2 * DAY_MS ? 60_000 : 3_600_000;
  const series = useMemo(
    () => zones.map((z) => ({ zone: z, points: bucketMean(data.filter((r) => r.zone_id === z), bucket) })).filter((s) => s.points.length),
    [data, zones, bucket],
  );
  const threshold = snap.settings.trust_threshold;
  const anomalies = useMemo(() => data.filter((r) => r.edge_anomaly_flag).map((r) => ({ t: new Date(r.ts).getTime(), v: r.value, T: r.trust_T, r })), [data]);
  const trusted = anomalies.filter((a) => a.T != null && a.T >= threshold);
  const lowTrust = anomalies.filter((a) => a.T == null || a.T < threshold);

  const controls = (
    <>
      <div>
        <Label htmlFor="ts-param" className="block text-xs">Parameter</Label>
        <Select id="ts-param" value={param} onChange={(e) => setParam(e.target.value)}>
          {snap.parameters.filter((x) => x.enabled).map((x) => (
            <option key={x.key} value={x.key}>{x.name}</option>
          ))}
        </Select>
      </div>
      <fieldset>
        <legend className="text-xs font-medium">Zones</legend>
        <div className="flex gap-2">
          {snap.zones.map((z) => (
            <label key={z.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={zones.includes(z.id)}
                onChange={(e) => setZones((cur) => (e.target.checked ? [...cur, z.id] : cur.filter((x) => x !== z.id)))}
              />
              <span style={{ color: seriesColor(z.id) }} aria-hidden>■</span>
              {z.code}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Label htmlFor="ts-src" className="block text-xs">Source</Label>
        <Select id="ts-src" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
          <option value="all">All</option>
          <option value="boat">Boat</option>
          <option value="station">Stations</option>
          <option value="lab">Lab samples</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="ts-range" className="block text-xs">Date range</Label>
        <Select id="ts-range" value={range} onChange={(e) => { setRange(e.target.value as RangeKey); setAnchor(Date.now()); }}>
          <option value="24h">Last 24 h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="custom">Custom</option>
        </Select>
      </div>
      {range === 'custom' && (
        <>
          <div>
            <Label htmlFor="ts-from" className="block text-xs">From</Label>
            <Input id="ts-from" type="date" className="h-9" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="ts-to" className="block text-xs">To</Label>
            <Input id="ts-to" type="date" className="h-9" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        </>
      )}
    </>
  );

  const values = data.map((r) => r.value);
  const yMax = Math.max(...values, p?.limit_high ?? 0, p?.limit_low ?? 0) * 1.1 || 1;

  return (
    <ChartCard
      title="Parameter over time"
      description={`${p?.name ?? param} (${p?.unit ?? ''}), ${bucket === 60_000 ? 'per-minute' : 'hourly'} means per zone. Shaded band = safe range; red points = anomalies, hollow = low trust.`}
      loading={loading}
      empty={!loading && (data.length === 0 || zones.length === 0)}
      emptyText={error ?? 'No readings for this parameter, zones and date range.'}
      controls={controls}
      csv={{
        filename: `readings-${param}`,
        rows: () => data.map((r) => ({ ts: r.ts, zone: r.zone_id, source_type: r.source_type, source_id: r.source_id, parameter: r.parameter_key, value: r.value, edge_anomaly: r.edge_anomaly_flag, trust_T: r.trust_T, lat: r.lat, lon: r.lon })),
      }}
    >
      <div className="h-80">
        <ResponsiveContainer>
          <ComposedChart margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
            <XAxis dataKey="t" type="number" scale="time" domain={[from, to]} tickFormatter={timeTick(span)} fontSize={11} allowDuplicatedCategory={false} />
            <YAxis dataKey="v" domain={[0, Math.ceil(yMax)]} fontSize={11} width={44} />
            {p?.limit_type === 'max' && p.limit_high != null && <ReferenceArea y1={0} y2={p.limit_high} fill="#16a34a" fillOpacity={0.07} />}
            {p?.limit_type === 'min' && p.limit_low != null && <ReferenceArea y1={p.limit_low} y2={Math.ceil(yMax)} fill="#16a34a" fillOpacity={0.07} />}
            {p?.limit_type === 'range' && <ReferenceArea y1={p.limit_low!} y2={p.limit_high!} fill="#16a34a" fillOpacity={0.07} />}
            {p?.limit_high != null && <ReferenceLine y={p.limit_high} stroke="#dc2626" strokeDasharray="6 4" label={{ value: `limit ${p.limit_high}`, fontSize: 10, position: 'insideTopRight', fill: '#b91c1c' }} />}
            {p?.limit_low != null && <ReferenceLine y={p.limit_low} stroke="#dc2626" strokeDasharray="6 4" label={{ value: `limit ${p.limit_low}`, fontSize: 10, position: 'insideBottomRight', fill: '#b91c1c' }} />}
            <Tooltip
              labelFormatter={(t) => fmtDateTime(Number(t))}
              formatter={(v: number, name: string) => [`${v} ${p?.unit ?? ''}`, name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {series.map((s, i) => (
              <Line key={s.zone} data={s.points} dataKey="v" name={`Zone ${s.zone}`} stroke={seriesColor(s.zone, i)} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
            ))}
            <Scatter
              data={trusted}
              dataKey="v"
              name="Anomaly (trusted)"
              fill="#dc2626"
              isAnimationActive={false}
              shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={3} fill="#dc2626" />}
            />
            <Scatter
              data={lowTrust}
              dataKey="v"
              name="Anomaly (low trust)"
              fill="#dc2626"
              isAnimationActive={false}
              shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={3.5} fill="none" stroke="#dc2626" strokeWidth={1.5} />}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

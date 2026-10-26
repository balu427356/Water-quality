import { useMemo, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { STATION_PROBES } from '@shared/demoLake.ts';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { ChartCard } from '@/components/ChartCard';
import { Label, Select } from '@/components/ui/form';
import { DAY_MS, TIME_ZONE, fmtDate, fmtShortDate } from '@/lib/time';
import { seriesColor } from './chartUtils';

const istDay = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export function StationTrends() {
  const snap = useSnapshot();
  const [param, setParam] = useState('do');
  const [days, setDays] = useState(30);
  const [anchor] = useState(() => Date.now());
  const { data, loading } = useReadings({ sourceTypes: ['station'], parameterKeys: [param], from: new Date(anchor - days * DAY_MS).toISOString() });
  const p = snap.parameters.find((x) => x.key === param);

  const daily = useMemo(() => {
    const m = new Map<string, Record<string, { min: number; max: number; sum: number; n: number }>>();
    for (const r of data) {
      const d = istDay.format(new Date(r.ts));
      const row = m.get(d) ?? {};
      const e = row[r.source_id] ?? { min: Infinity, max: -Infinity, sum: 0, n: 0 };
      e.min = Math.min(e.min, r.value);
      e.max = Math.max(e.max, r.value);
      e.sum += r.value;
      e.n += 1;
      row[r.source_id] = e;
      m.set(d, row);
    }
    return [...m.entries()].sort().map(([day, row]) => {
      const out: Record<string, number | string | [number, number]> = { day, t: new Date(`${day}T12:00:00+05:30`).getTime() };
      for (const [sid, e] of Object.entries(row)) {
        out[`${sid}_range`] = [round2(e.min), round2(e.max)];
        out[`${sid}_mean`] = round2(e.sum / e.n);
        out[`${sid}_min`] = round2(e.min);
        out[`${sid}_max`] = round2(e.max);
      }
      return out;
    });
  }, [data]);

  return (
    <ChartCard
      title="Fixed-station trends"
      description={`Daily min–max band and mean of ${p?.name ?? param} at each station (IST days).`}
      loading={loading}
      empty={!loading && daily.length === 0}
      controls={
        <>
          <div>
            <Label htmlFor="st-param" className="block text-xs">Parameter</Label>
            <Select id="st-param" value={param} onChange={(e) => setParam(e.target.value)}>
              {snap.parameters.filter((x) => (STATION_PROBES as readonly string[]).includes(x.key)).map((x) => (
                <option key={x.key} value={x.key}>{x.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="st-days" className="block text-xs">Period</Label>
            <Select id="st-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </Select>
          </div>
        </>
      }
      csv={{
        filename: `station-daily-${param}`,
        rows: () => daily.flatMap((d) => snap.stations.filter((s) => d[`${s.id}_mean`] != null).map((s) => ({ day: d.day as string, station: s.id, parameter: param, min: d[`${s.id}_min`] as number, mean: d[`${s.id}_mean`] as number, max: d[`${s.id}_max`] as number }))),
      }}
    >
      <div className="h-72">
        <ResponsiveContainer>
          <ComposedChart data={daily} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t) => fmtShortDate(t)} fontSize={11} />
            <YAxis fontSize={11} width={44} domain={['auto', 'auto']} />
            {p?.limit_high != null && <ReferenceLine y={p.limit_high} stroke="#dc2626" strokeDasharray="6 4" />}
            {p?.limit_low != null && <ReferenceLine y={p.limit_low} stroke="#dc2626" strokeDasharray="6 4" />}
            <Tooltip labelFormatter={(t) => fmtDate(Number(t))} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {snap.stations.map((s, i) => (
              <Area key={`${s.id}-band`} dataKey={`${s.id}_range`} name={`${s.id} min–max`} stroke="none" fill={seriesColor(s.id, i)} fillOpacity={0.15} isAnimationActive={false} />
            ))}
            {snap.stations.map((s, i) => (
              <Line key={`${s.id}-mean`} dataKey={`${s.id}_mean`} name={`${s.name} mean`} stroke={seriesColor(s.id, i)} dot={false} strokeWidth={2} isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;

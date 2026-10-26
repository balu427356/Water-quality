import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { paramName } from '@/data/selectors';
import { ChartCard } from '@/components/ChartCard';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { DAY_MS, fmtDateTime } from '@/lib/time';

export function TrustHistogram() {
  const snap = useSnapshot();
  const [since] = useState(() => new Date(Date.now() - 90 * DAY_MS).toISOString());
  const { data, loading } = useReadings({ from: since, maxTrust: 1.01 });
  const threshold = snap.settings.trust_threshold;

  const bins = useMemo(() => {
    const b = Array.from({ length: 10 }, (_, i) => ({ bin: i / 10, label: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`, count: 0 }));
    for (const r of data) if (r.trust_T != null) b[Math.min(9, Math.floor(r.trust_T * 10))].count += 1;
    return b;
  }, [data]);
  const lowest = useMemo(() => [...data].sort((a, b) => (a.trust_T ?? 1) - (b.trust_T ?? 1)).slice(0, 10), [data]);

  return (
    <ChartCard
      title="Trust score distribution"
      description={`Trust T of anomalous readings over the last 90 days. Bars below the ${threshold} threshold are likely sensor faults.`}
      loading={loading}
      empty={!loading && data.length === 0}
      emptyText="No anomalous readings with a trust score in the last 90 days."
      csv={{ filename: 'trust-scores', rows: () => data.map((r) => ({ ts: r.ts, zone: r.zone_id, source_id: r.source_id, parameter: r.parameter_key, value: r.value, trust_T: r.trust_T })) }}
    >
      <div className="h-56">
        <ResponsiveContainer>
          <BarChart data={bins} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
            <XAxis dataKey="label" fontSize={10} interval={0} angle={-30} textAnchor="end" height={40} />
            <YAxis allowDecimals={false} fontSize={11} width={36} />
            <Tooltip formatter={(v: number) => [v, 'readings']} />
            <ReferenceLine x={bins[Math.round(threshold * 10)]?.label} stroke="#334155" strokeDasharray="4 4" label={{ value: 'threshold', fontSize: 10, position: 'top' }} />
            <Bar dataKey="count" isAnimationActive={false}>
              {bins.map((b) => (
                <Cell key={b.label} fill={b.bin < threshold ? '#d97706' : '#0e7490'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <h3 className="mt-3 text-sm font-semibold">Lowest-trust readings</h3>
      <Table>
        <THead>
          <TR><TH>Time</TH><TH>Zone</TH><TH>Source</TH><TH>Parameter</TH><TH>Value</TH><TH>T</TH></TR>
        </THead>
        <TBody>
          {lowest.map((r) => (
            <TR key={r.id}>
              <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.ts)}</TD>
              <TD>{r.zone_id ?? '–'}</TD>
              <TD>{r.source_id}</TD>
              <TD>{paramName(snap, r.parameter_key)}</TD>
              <TD className="tabular-nums">{r.value}</TD>
              <TD className="tabular-nums font-semibold">{r.trust_T?.toFixed(2)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </ChartCard>
  );
}

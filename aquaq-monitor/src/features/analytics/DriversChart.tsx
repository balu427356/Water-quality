import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useSnapshot } from '@/data/DataProvider';
import { latestSurvey, paramName, scoresBySurvey } from '@/data/selectors';
import { ChartCard } from '@/components/ChartCard';
import { Label, Select } from '@/components/ui/form';

export function DriversChart() {
  const snap = useSnapshot();
  const [zone, setZone] = useState(snap.zones[0]?.id ?? '');
  const survey = latestSurvey(snap);
  const score = scoresBySurvey(snap, survey?.id)[zone];
  const data = (score?.top_drivers ?? []).map((d) => ({ ...d, name: paramName(snap, d.parameter_key) }));

  return (
    <ChartCard
      title="Parameter drivers"
      description="Contribution to risk in the latest survey = hazard weight × (mean ÷ limit − 0.75). Right of zero pushes toward unsafe."
      empty={data.length === 0}
      controls={
        <div>
          <Label htmlFor="drv-zone" className="block text-xs">Zone</Label>
          <Select id="drv-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
            {snap.zones.map((z) => (
              <option key={z.id} value={z.id}>{z.code} · {z.name}</option>
            ))}
          </Select>
        </div>
      }
      csv={{ filename: `drivers-zone-${zone}`, rows: () => data.map((d) => ({ zone, parameter: d.parameter_key, mean_value: d.value, limit: d.limit, contribution: d.contribution })) }}
    >
      <div className="h-72">
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.4} />
            <XAxis type="number" fontSize={11} />
            <YAxis type="category" dataKey="name" width={130} fontSize={11} />
            <ReferenceLine x={0} stroke="#334155" />
            <Tooltip formatter={(v: number, _n, item) => [`${v} (mean ${item.payload.value}, limit ${item.payload.limit})`, 'Contribution']} />
            <Bar dataKey="contribution" isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.parameter_key} fill={d.contribution > 0 ? '#dc2626' : '#16a34a'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  );
}

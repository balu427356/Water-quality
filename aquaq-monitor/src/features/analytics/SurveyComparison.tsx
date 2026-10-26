import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TIER_ORDER, round, trendOf } from '@shared/limits.ts';
import type { RiskTier } from '@shared/types.ts';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { completedSurveys, scoresBySurvey } from '@/data/selectors';
import { ChartCard } from '@/components/ChartCard';
import { LakeMap } from '@/components/map/LakeMap';
import { TierBadge, TrendIndicator } from '@/components/status';
import { Label, Select } from '@/components/ui/form';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { fmtDate } from '@/lib/time';
import { mean } from './chartUtils';

export function SurveyComparison() {
  const snap = useSnapshot();
  const surveys = completedSurveys(snap);
  const [a, setA] = useState(surveys[surveys.length - 2]?.id ?? '');
  const [b, setB] = useState(surveys[surveys.length - 1]?.id ?? '');
  const [param, setParam] = useState('turbidity');
  const { data, loading } = useReadings(a && b ? { surveyIds: [a, b] } : null);
  const sa = scoresBySurvey(snap, a);
  const sb = scoresBySurvey(snap, b);
  const p = snap.parameters.find((x) => x.key === param);

  const rows = useMemo(
    () =>
      snap.zones.map((z) => {
        const ma = mean(data.filter((r) => r.survey_id === a && r.zone_id === z.id && r.parameter_key === param).map((r) => r.value));
        const mb = mean(data.filter((r) => r.survey_id === b && r.zone_id === z.id && r.parameter_key === param).map((r) => r.value));
        const ra = sa[z.id]?.risk_R;
        const rb = sb[z.id]?.risk_R;
        return { zone: z, ra, rb, dR: ra != null && rb != null ? rb - ra : null, ma, mb, tierA: sa[z.id]?.risk_tier, tierB: sb[z.id]?.risk_tier, trend: rb != null ? trendOf(rb, ra) : ('stable' as const) };
      }),
    [snap.zones, data, a, b, param, sa, sb],
  );
  const worsening = rows.filter((r) => r.trend === 'worsening');
  const improving = rows.filter((r) => r.trend === 'improving');
  const tiersA = Object.fromEntries(rows.map((r) => [r.zone.id, r.tierA])) as Record<string, RiskTier | undefined>;
  const tiersB = Object.fromEntries(rows.map((r) => [r.zone.id, r.tierB])) as Record<string, RiskTier | undefined>;
  const label = (id: string) => {
    const s = surveys.find((x) => x.id === id);
    return s ? `${s.id} · ${fmtDate(s.started_at)}` : id;
  };

  const controls = (
    <>
      {[
        ['Baseline survey', a, setA, 'cmp-a'] as const,
        ['Compare with', b, setB, 'cmp-b'] as const,
      ].map(([lbl, val, set, id]) => (
        <div key={id}>
          <Label htmlFor={id} className="block text-xs">{lbl}</Label>
          <Select id={id} value={val} onChange={(e) => set(e.target.value)}>
            {surveys.map((s) => (
              <option key={s.id} value={s.id}>{label(s.id)}</option>
            ))}
          </Select>
        </div>
      ))}
      <div>
        <Label htmlFor="cmp-param" className="block text-xs">Parameter mean</Label>
        <Select id="cmp-param" value={param} onChange={(e) => setParam(e.target.value)}>
          {snap.parameters.filter((x) => x.enabled).map((x) => (
            <option key={x.key} value={x.key}>{x.name}</option>
          ))}
        </Select>
      </div>
    </>
  );

  return (
    <ChartCard
      title="Survey comparison"
      description="Per-zone change in risk R and in the mean of a parameter between two surveys."
      loading={loading}
      empty={surveys.length < 2}
      emptyText="At least two completed surveys are needed for a comparison."
      controls={controls}
      csv={{
        filename: `survey-comparison-${a}-vs-${b}`,
        rows: () => rows.map((r) => ({ zone: r.zone.code, R_baseline: r.ra, R_compare: r.rb, delta_R: r.dR == null ? null : round(r.dR, 3), tier_baseline: r.tierA, tier_compare: r.tierB, [`${param}_mean_baseline`]: r.ma == null ? null : round(r.ma, 3), [`${param}_mean_compare`]: r.mb == null ? null : round(r.mb, 3) })),
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        {[
          [a, tiersA],
          [b, tiersB],
        ].map(([id, tiers]) => (
          <figure key={id as string}>
            <div className="h-48 overflow-hidden rounded-md border">
              <LakeMap snap={snap} tiers={tiers as Record<string, RiskTier | undefined>} interactive={false} className="h-full w-full" layers={{ route: false, trail: false, boat: false, samples: false, geofence: false, stations: false }} />
            </div>
            <figcaption className="mt-1 text-xs text-muted-foreground">{label(id as string)}</figcaption>
          </figure>
        ))}
      </div>

      <Table className="mt-3">
        <THead>
          <TR>
            <TH>Zone</TH>
            <TH>R (baseline → compare)</TH>
            <TH>ΔR</TH>
            <TH>Tier</TH>
            <TH>{p?.name} mean</TH>
            <TH>Trend</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.zone.id}>
              <TD><Link className="font-medium text-primary hover:underline" to={`/zones/${r.zone.id}`}>{r.zone.code} · {r.zone.name}</Link></TD>
              <TD className="tabular-nums">{r.ra?.toFixed(2) ?? '–'} → {r.rb?.toFixed(2) ?? '–'}</TD>
              <TD className="tabular-nums">{r.dR == null ? '–' : `${r.dR > 0 ? '+' : ''}${r.dR.toFixed(2)}`}</TD>
              <TD>
                <span className="inline-flex flex-wrap items-center gap-1">
                  <TierBadge tier={r.tierA} /> → <TierBadge tier={r.tierB} />
                  {r.tierA && r.tierB && TIER_ORDER.indexOf(r.tierB) > TIER_ORDER.indexOf(r.tierA) && <span className="text-xs font-semibold text-red-700 dark:text-red-300">tier rose</span>}
                </span>
              </TD>
              <TD className="tabular-nums">
                {r.ma?.toFixed(2) ?? '–'} → {r.mb?.toFixed(2) ?? '–'} <span className="text-xs text-muted-foreground">{p?.unit}</span>
              </TD>
              <TD><TrendIndicator trend={r.trend} /></TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ZoneList title="Worsening zones" rows={worsening.map((r) => `${r.zone.code} · ${r.zone.name} (R +${r.dR!.toFixed(2)})`)} />
        <ZoneList title="Improving zones" rows={improving.map((r) => `${r.zone.code} · ${r.zone.name} (R ${r.dR!.toFixed(2)})`)} />
      </div>
    </ChartCard>
  );
}

function ZoneList({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div className="rounded-md border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length ? (
        <ul className="mt-1 list-disc pl-5 text-sm">{rows.map((r) => <li key={r}>{r}</li>)}</ul>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">None</p>
      )}
    </div>
  );
}

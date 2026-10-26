import { useMemo, useState } from 'react';
import { useSnapshot } from '@/data/DataProvider';
import { useReadings } from '@/data/useReadings';
import { latestSurvey } from '@/data/selectors';
import { ChartCard } from '@/components/ChartCard';
import { Label, Select } from '@/components/ui/form';
import { cn } from '@/lib/utils';
import { sampleMatrixItems, zoneMatrixItems } from './riskMatrix';

const LEVELS = [1, 2, 3, 4, 5];

function cellColor(score: number) {
  if (score >= 15) return 'bg-red-200 dark:bg-red-900';
  if (score >= 8) return 'bg-orange-200 dark:bg-orange-900';
  if (score >= 4) return 'bg-yellow-100 dark:bg-yellow-900';
  return 'bg-green-100 dark:bg-green-950';
}
function cellBand(score: number) {
  return score >= 15 ? 'Critical' : score >= 8 ? 'High' : score >= 4 ? 'Medium' : 'Low';
}

export function RiskMatrix() {
  const snap = useSnapshot();
  const survey = latestSurvey(snap);
  const [mode, setMode] = useState<'zones' | 'samples'>('zones');
  const { data, loading } = useReadings(survey ? { surveyIds: [survey.id] } : null);
  const items = useMemo(
    () => (mode === 'zones' ? zoneMatrixItems(data, snap.parameters, snap.zones.map((z) => z.id), snap.settings.near_limit_pct) : sampleMatrixItems(data, snap.parameters)),
    [mode, data, snap.parameters, snap.zones, snap.settings.near_limit_pct],
  );
  const cell = (prob: number, sev: number) => items.filter((i) => i.probability === prob && i.severity === sev);

  return (
    <ChartCard
      title="5 × 5 risk matrix"
      description={
        mode === 'zones'
          ? 'Latest survey. Probability = share of readings near or outside a limit; severity = worst hazard-weighted limit ratio of zone means.'
          : 'Latest survey. Probability = trust T of the sample’s anomaly (0.1 if none); severity = worst hazard-weighted limit ratio.'
      }
      loading={loading}
      empty={!loading && data.length === 0}
      controls={
        <div>
          <Label htmlFor="rm-mode" className="block text-xs">Count</Label>
          <Select id="rm-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="zones">Zones</option>
            <option value="samples">Samples</option>
          </Select>
        </div>
      }
      csv={{ filename: `risk-matrix-${mode}`, rows: () => items.map((i) => ({ item: i.label, probability_level: i.probability, severity_level: i.severity })) }}
    >
      <div className="overflow-x-auto">
        <table className="mx-auto border-separate border-spacing-1 text-sm">
          <caption className="sr-only">Count of {mode} by probability (rows) and severity (columns)</caption>
          <thead>
            <tr>
              <th scope="col" className="text-xs text-muted-foreground">Probability ↓ / Severity →</th>
              {LEVELS.map((s) => (
                <th key={s} scope="col" className="w-14 text-xs font-medium">{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...LEVELS].reverse().map((prob) => (
              <tr key={prob}>
                <th scope="row" className="pr-2 text-right text-xs font-medium">{prob}</th>
                {LEVELS.map((sev) => {
                  const c = cell(prob, sev);
                  const score = prob * sev;
                  return (
                    <td
                      key={sev}
                      className={cn('h-12 w-14 rounded text-center align-middle', cellColor(score))}
                      title={`${cellBand(score)} · probability ${prob}, severity ${sev}${c.length && mode === 'zones' ? ': ' + c.map((i) => i.label).join(', ') : ''}`}
                    >
                      <div className="text-base font-semibold tabular-nums">{c.length || ''}</div>
                      {mode === 'zones' && c.length > 0 && <div className="text-[10px] leading-tight">{c.map((i) => i.id).join(' ')}</div>}
                      <span className="sr-only">{cellBand(score)} band</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

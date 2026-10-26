import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText } from 'lucide-react';
import type { SourceType } from '@shared/types.ts';
import { useSnapshot } from '@/data/DataProvider';
import { scoresBySurvey, worstTier } from '@/data/selectors';
import { useReadings } from '@/data/useReadings';
import type { ReadingQuery } from '@/data/source';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/form';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { TierBadge } from '@/components/status';
import { PageHeader } from '@/features/layout/AppShell';
import { downloadCsv } from '@/lib/csv';
import { DAY_MS, fmtDate, fmtDateTime } from '@/lib/time';
import { readingRows } from './exportRows';

export function ReportsPage() {
  const snap = useSnapshot();
  const surveys = [...snap.surveys].filter((s) => s.status === 'completed').reverse();
  return (
    <div className="pb-6">
      <PageHeader title="Reports" description="One report per survey (export as PDF) and raw readings as CSV." />
      <div className="grid gap-3 px-4 md:px-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Survey reports</CardTitle>
              <CardDescription>Summary, zone table, maps, charts, alerts raised, missions run and the solver used.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Survey</TH>
                  <TH>Date</TH>
                  <TH>Type</TH>
                  <TH>Mission</TH>
                  <TH>Worst tier</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {surveys.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-medium">{s.id}</TD>
                    <TD>{fmtDate(s.started_at)}</TD>
                    <TD className="capitalize">{s.type}</TD>
                    <TD>{s.mission_id ?? <span className="text-muted-foreground">–</span>}</TD>
                    <TD>
                      <TierBadge tier={worstTier(Object.values(scoresBySurvey(snap, s.id)))} />
                    </TD>
                    <TD>
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/reports/${s.id}`}>
                          <FileText className="h-4 w-4" aria-hidden /> Open report
                        </Link>
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <RawExport />
      </div>
    </div>
  );
}

function RawExport() {
  const snap = useSnapshot();
  const [anchor] = useState(() => Date.now());
  const istDate = (t: number) => new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(istDate(anchor - 30 * DAY_MS));
  const [to, setTo] = useState(istDate(anchor));
  const [zones, setZones] = useState<string[]>([]);
  const [params, setParams] = useState<string[]>([]);
  const [sources, setSources] = useState<SourceType[]>(['boat', 'station', 'lab']);
  const [survey, setSurvey] = useState('');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [lowTrustOnly, setLowTrustOnly] = useState(false);

  const query = useMemo<ReadingQuery>(
    () => ({
      from: new Date(`${from}T00:00:00+05:30`).toISOString(),
      to: new Date(`${to}T23:59:59.999+05:30`).toISOString(),
      zoneIds: zones.length ? zones : undefined,
      parameterKeys: params.length ? params : undefined,
      sourceTypes: sources,
      surveyIds: survey ? [survey] : undefined,
      maxTrust: lowTrustOnly ? snap.settings.trust_threshold : undefined,
    }),
    [from, to, zones, params, sources, survey, lowTrustOnly, snap.settings.trust_threshold],
  );
  const { data, loading, error } = useReadings(from && to && sources.length ? query : null);
  const rows = useMemo(() => (anomaliesOnly ? data.filter((r) => r.edge_anomaly_flag) : data), [data, anomaliesOnly]);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Raw data export</CardTitle>
          <CardDescription>All readings matching the filters, one row each, with the limit and its status. Times in UTC and IST.</CardDescription>
        </div>
        <Button
          disabled={loading || !rows.length}
          onClick={() => downloadCsv(`aquaq-readings-${from}-to-${to}`, readingRows(rows, snap.parameters, snap.settings))}
        >
          <Download className="h-4 w-4" aria-hidden /> Download CSV ({rows.length.toLocaleString('en-IN')} rows)
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="ex-from" className="block text-xs">From (IST)</Label>
            <Input id="ex-from" type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ex-to" className="block text-xs">To (IST)</Label>
            <Input id="ex-to" type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ex-survey" className="block text-xs">Survey</Label>
            <select id="ex-survey" className="h-9 rounded-md border border-input bg-card px-2 text-sm" value={survey} onChange={(e) => setSurvey(e.target.value)}>
              <option value="">Any</option>
              {snap.surveys.map((s) => (
                <option key={s.id} value={s.id}>{s.id} · {fmtDate(s.started_at)}</option>
              ))}
            </select>
          </div>
        </div>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="mb-1 text-xs font-medium">Zones (none ticked = all)</legend>
          {snap.zones.map((z) => (
            <label key={z.id} className="flex items-center gap-1">
              <input type="checkbox" checked={zones.includes(z.id)} onChange={(e) => setZones(toggle(zones, z.id, e.target.checked))} /> {z.code} · {z.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="mb-1 text-xs font-medium">Parameters (none ticked = all)</legend>
          {snap.parameters.map((p) => (
            <label key={p.key} className="flex items-center gap-1">
              <input type="checkbox" checked={params.includes(p.key)} onChange={(e) => setParams(toggle(params, p.key, e.target.checked))} /> {p.name}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="mb-1 text-xs font-medium">Sources and flags</legend>
          {(['boat', 'station', 'lab'] as const).map((s) => (
            <label key={s} className="flex items-center gap-1 capitalize">
              <input type="checkbox" checked={sources.includes(s)} onChange={(e) => setSources(toggle(sources, s, e.target.checked))} /> {s}
            </label>
          ))}
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={anomaliesOnly} onChange={(e) => setAnomaliesOnly(e.target.checked)} /> Anomalies only
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={lowTrustOnly} onChange={(e) => setLowTrustOnly(e.target.checked)} /> Low trust only (T &lt; {snap.settings.trust_threshold})
          </label>
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <p role="status" className="text-sm text-muted-foreground">
          {loading ? 'Counting…' : `${rows.length.toLocaleString('en-IN')} readings match. First 5:`}
        </p>
        {!loading && rows.length > 0 && (
          <Table>
            <THead>
              <TR><TH>Time</TH><TH>Source</TH><TH>Zone</TH><TH>Parameter</TH><TH>Value</TH><TH>T</TH></TR>
            </THead>
            <TBody>
              {rows.slice(0, 5).map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-xs">{fmtDateTime(r.ts)}</TD>
                  <TD>{r.source_id}</TD>
                  <TD>{r.zone_id ?? '–'}</TD>
                  <TD>{r.parameter_key}</TD>
                  <TD className="tabular-nums">{r.value}</TD>
                  <TD className="tabular-nums">{r.trust_T ?? '–'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

import { useSnapshot } from '@/data/DataProvider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/features/layout/AppShell';
import { fmtDateTime } from '@/lib/time';

export const SOLVER_LABEL: Record<string, string> = {
  quantum_qaoa: 'Quantum (QAOA)',
  quantum_annealer: 'Quantum (annealer)',
  classical_fallback: 'Classical fallback',
  mock: 'Mock planner',
};

const LEVEL_LABEL: Record<string, string> = {
  skip: 'Skip',
  standard_25m: 'Standard 25 m',
  dense_10m: 'Dense 10 m',
  hotspot_5m: 'Hotspot 5 m',
  confirm: 'Confirm sample',
};

export function MissionsPage() {
  const snap = useSnapshot();
  return (
    <div className="pb-6">
      <PageHeader title="Missions" description="Read-only in Phase 1. Planning, approval and sending to the boat arrive in Phase 3." />
      <div className="grid gap-3 px-4 md:px-6">
        {snap.missions.map((m) => {
          const zones = snap.missionZones.filter((z) => z.mission_id === m.id);
          return (
            <Card key={m.id}>
              <CardHeader>
                <div>
                  <CardTitle>
                    {m.id} · {m.name}
                  </CardTitle>
                  <CardDescription>
                    Created {fmtDateTime(m.created_at)} by {m.created_by}
                    {m.approved_by && ` · approved by ${m.approved_by}`}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge className="capitalize">{m.status}</Badge>
                  <Badge>Solver: {SOLVER_LABEL[m.solver]}</Badge>
                  <Badge>
                    Energy {m.energy_planned} / {m.energy_budget}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
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
                        <TD className="tabular-nums">{z.risk_R}</TD>
                        <TD className="tabular-nums">{z.trust_T}</TD>
                        <TD>{LEVEL_LABEL[z.level]}</TD>
                        <TD className="tabular-nums">{z.energy}</TD>
                        <TD className="text-sm">{z.reason}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

import { PageHeader } from '@/features/layout/AppShell';
import { TimeSeriesChart } from './TimeSeriesChart';
import { SurveyComparison } from './SurveyComparison';
import { RiskMatrix } from './RiskMatrix';
import { TrustHistogram } from './TrustHistogram';
import { DriversChart } from './DriversChart';
import { StationTrends } from './StationTrends';

export function AnalyticsPage() {
  return (
    <div className="pb-6">
      <PageHeader title="Analytics" description="Trends, survey comparison, risk and trust. Every chart exports its data as CSV." />
      <div className="grid gap-3 px-4 md:px-6 xl:grid-cols-2">
        <TimeSeriesChart />
        <StationTrends />
        <div className="xl:col-span-2">
          <SurveyComparison />
        </div>
        <div className="grid gap-3">
          <RiskMatrix />
          <DriversChart />
        </div>
        <TrustHistogram />
      </div>
    </div>
  );
}

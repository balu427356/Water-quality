import type { ReactNode } from 'react';
import { Download, Loader2, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { downloadCsv, type CsvRow } from '@/lib/csv';

interface Props {
  title: string;
  description?: string;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  csv?: { filename: string; rows: () => CsvRow[] };
  controls?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Card wrapper giving every chart a loading state, an empty state and CSV export. */
export function ChartCard({ title, description, loading, empty, emptyText, csv, controls, children, className }: Props) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {csv && (
          <Button variant="outline" size="sm" disabled={loading || empty} onClick={() => downloadCsv(csv.filename, csv.rows())}>
            <Download className="h-4 w-4" aria-hidden /> CSV
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {controls && <div className="mb-3 flex flex-wrap items-end gap-3">{controls}</div>}
        {loading ? <LoadingState /> : empty ? <EmptyState text={emptyText} /> : children}
      </CardContent>
    </Card>
  );
}

export function LoadingState({ text = 'Loading data…' }: { text?: string }) {
  return (
    <div role="status" className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> {text}
    </div>
  );
}

export function EmptyState({ text = 'No data for the selected filters.' }: { text?: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <SearchX className="h-6 w-6" aria-hidden />
      {text}
    </div>
  );
}

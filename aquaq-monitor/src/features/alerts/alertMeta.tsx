import { AlertOctagon, AlertTriangle, BellRing, CheckCircle2, Circle, Eye, Info } from 'lucide-react';
import type { AlertCategory, AlertSeverity, AlertStatus } from '@shared/types.ts';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SEV: Record<AlertSeverity, { label: string; cls: string; Icon: typeof Info }> = {
  info: { label: 'Info', cls: 'border-sky-700/30 bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-100', Icon: Info },
  warning: { label: 'Warning', cls: 'border-yellow-700/30 bg-yellow-50 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-100', Icon: AlertTriangle },
  high: { label: 'High', cls: 'border-orange-700/30 bg-orange-50 text-orange-900 dark:bg-orange-950 dark:text-orange-100', Icon: AlertTriangle },
  critical: { label: 'Critical', cls: 'border-red-700/40 bg-red-600 text-white dark:bg-red-700', Icon: AlertOctagon },
};

export const SEVERITY_BAR: Record<AlertSeverity, string> = {
  info: 'border-l-sky-600',
  warning: 'border-l-yellow-500',
  high: 'border-l-orange-600',
  critical: 'border-l-red-600',
};

export function SeverityBadge({ severity, className }: { severity: AlertSeverity; className?: string }) {
  const m = SEV[severity];
  return (
    <Badge className={cn(m.cls, className)}>
      <m.Icon className="h-3.5 w-3.5" aria-hidden />
      {m.label}
    </Badge>
  );
}

const STATUS: Record<AlertStatus, { label: string; Icon: typeof Info; cls: string }> = {
  open: { label: 'Open', Icon: Circle, cls: 'text-red-800 dark:text-red-200' },
  acknowledged: { label: 'Acknowledged', Icon: Eye, cls: 'text-amber-800 dark:text-amber-200' },
  resolved: { label: 'Resolved', Icon: CheckCircle2, cls: 'text-green-800 dark:text-green-200' },
};

export function AlertStatusLabel({ status }: { status: AlertStatus }) {
  const m = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', m.cls)}>
      <m.Icon className="h-3.5 w-3.5" aria-hidden />
      {m.label}
    </span>
  );
}

export const CATEGORY_LABEL: Record<AlertCategory, string> = {
  water_quality: 'Water quality',
  sensor: 'Sensor',
  boat: 'Boat',
  mission: 'Mission',
  system: 'System',
};

export { BellRing };

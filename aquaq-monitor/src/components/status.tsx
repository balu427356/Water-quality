// Status indicators. Colour is never the only signal: each one has an icon and a text label.
import { AlertOctagon, AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle2, Info, MinusCircle, XCircle } from 'lucide-react';
import type { RiskTier, SensorHealth } from '@shared/types.ts';
import type { LimitStatus, Trend } from '@shared/limits.ts';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const TIER_COLOR: Record<RiskTier, string> = {
  Low: '#16a34a',
  Medium: '#ca8a04',
  High: '#ea580c',
  Critical: '#dc2626',
};

const TIER_STYLE: Record<RiskTier, string> = {
  Low: 'border-green-700/30 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200',
  Medium: 'border-yellow-700/30 bg-yellow-50 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200',
  High: 'border-orange-700/30 bg-orange-50 text-orange-900 dark:bg-orange-950 dark:text-orange-200',
  Critical: 'border-red-700/30 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200',
};
const TIER_ICON = { Low: CheckCircle2, Medium: Info, High: AlertTriangle, Critical: AlertOctagon };

export function TierBadge({ tier, className }: { tier: RiskTier | null | undefined; className?: string }) {
  if (!tier) return <Badge className="text-muted-foreground">No score</Badge>;
  const Icon = TIER_ICON[tier];
  return (
    <Badge className={cn(TIER_STYLE[tier], className)}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {tier}
    </Badge>
  );
}

const LIMIT_META: Record<LimitStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: 'Within limit', cls: 'border-green-700/30 bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200', Icon: CheckCircle2 },
  near: { label: 'Near limit', cls: 'border-yellow-700/30 bg-yellow-50 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200', Icon: AlertTriangle },
  out: { label: 'Outside limit', cls: 'border-red-700/30 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200', Icon: XCircle },
  none: { label: 'Trend only', cls: 'text-muted-foreground', Icon: MinusCircle },
};

export function LimitBadge({ status }: { status: LimitStatus }) {
  const m = LIMIT_META[status];
  return (
    <Badge className={m.cls}>
      <m.Icon className="h-3.5 w-3.5" aria-hidden />
      {m.label}
    </Badge>
  );
}

export function TrendIndicator({ trend }: { trend: Trend }) {
  const m = {
    worsening: { Icon: ArrowUpRight, cls: 'text-red-700 dark:text-red-300', label: 'Worsening' },
    improving: { Icon: ArrowDownRight, cls: 'text-green-700 dark:text-green-300', label: 'Improving' },
    stable: { Icon: ArrowRight, cls: 'text-muted-foreground', label: 'Stable' },
  }[trend];
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', m.cls)}>
      <m.Icon className="h-4 w-4" aria-hidden />
      {m.label}
    </span>
  );
}

const HEALTH_META: Record<SensorHealth, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: 'OK', cls: LIMIT_META.ok.cls, Icon: CheckCircle2 },
  drift_suspected: { label: 'Drift suspected', cls: LIMIT_META.near.cls, Icon: AlertTriangle },
  fouling_suspected: { label: 'Fouling suspected', cls: LIMIT_META.near.cls, Icon: AlertTriangle },
  failed: { label: 'Failed', cls: LIMIT_META.out.cls, Icon: XCircle },
};

export function HealthBadge({ health }: { health: SensorHealth }) {
  const m = HEALTH_META[health];
  return (
    <Badge className={m.cls}>
      <m.Icon className="h-3.5 w-3.5" aria-hidden />
      {m.label}
    </Badge>
  );
}

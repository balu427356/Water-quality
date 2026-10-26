import { CheckCircle2, Clock, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { COMMAND_LABEL } from '@shared/commands.ts';
import type { Command, CommandStatus } from '@shared/types.ts';
import { canOperate, useData, useSnapshot } from '@/data/DataProvider';
import { Button } from '@/components/ui/button';
import { fmtTime } from '@/lib/time';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';
import { useCommand } from './useCommand';

const META: Record<CommandStatus, { label: string; Icon: typeof Clock; cls: string }> = {
  pending: { label: 'Pending', Icon: Loader2, cls: 'text-muted-foreground' },
  acknowledged: { label: 'Acknowledged', Icon: Clock, cls: 'text-sky-800 dark:text-sky-200' },
  executed: { label: 'Executed', Icon: CheckCircle2, cls: 'text-green-800 dark:text-green-200' },
  failed: { label: 'Failed', Icon: XCircle, cls: 'text-red-800 dark:text-red-200' },
  timed_out: { label: 'Timed out', Icon: XCircle, cls: 'text-red-800 dark:text-red-200' },
};

/** Recent commands with pending → acknowledged → executed progress and a retry for failures. */
export function CommandList({ limit = 6 }: { limit?: number }) {
  const snap = useSnapshot();
  const { user } = useData();
  const now = useNow(1000);
  const cmd = useCommand();
  const timeout = snap.settings.command_timeout_s;
  const list = snap.commands.filter((c) => c.type !== 'MANUAL_DRIVE').slice(0, limit);
  if (!list.length) return <p className="text-xs text-muted-foreground">No commands sent yet.</p>;

  return (
    <div>
      <ol className="space-y-1.5" aria-label="Recent commands">
        {list.map((c) => (
          <Row key={c.id} c={c} now={now} timeout={timeout} canRetry={canOperate(user)} onRetry={() => void cmd.send(c.type, c.payload)} retryBusy={cmd.busy} />
        ))}
      </ol>
      {cmd.error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Retry rejected: {cmd.error.message}
        </p>
      )}
    </div>
  );
}

function Row({ c, now, timeout, canRetry, onRetry, retryBusy }: { c: Command; now: number; timeout: number; canRetry: boolean; onRetry: () => void; retryBusy: boolean }) {
  const m = META[c.status];
  const waiting = c.status === 'pending' ? Math.max(0, timeout - (now - new Date(c.issued_at).getTime()) / 1000) : null;
  return (
    <li className="flex items-start justify-between gap-2 rounded border px-2 py-1.5 text-sm">
      <div className="min-w-0">
        <div className="font-medium">{COMMAND_LABEL[c.type]}</div>
        <div className="text-xs text-muted-foreground">
          {fmtTime(c.issued_at)}
          {c.status === 'pending' && waiting != null && ` · waiting for the boat (${Math.ceil(waiting)} s)`}
          {c.result && ` · ${c.result}`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 text-xs font-medium', m.cls)}>
          <m.Icon className={cn('h-3.5 w-3.5', c.status === 'pending' && 'animate-spin')} aria-hidden />
          {m.label}
        </span>
        {canRetry && (c.status === 'failed' || c.status === 'timed_out') && (
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={onRetry} disabled={retryBusy} aria-label={`Retry ${COMMAND_LABEL[c.type]}`}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
          </Button>
        )}
      </div>
    </li>
  );
}

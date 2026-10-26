import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { runChecklist } from '@shared/commands.ts';
import { isAdmin, useSnapshot, useUser } from '@/data/DataProvider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/form';
import { useNow } from '@/lib/useNow';
import { useCommand } from './useCommand';

/** Pre-mission checklist. Start is blocked until it passes unless an admin overrides with a reason (logged). */
export function StartMissionDialog({ missionId, open, onClose }: { missionId: string; open: boolean; onClose: () => void }) {
  const snap = useSnapshot();
  const user = useUser();
  const now = useNow(2000);
  const cmd = useCommand();
  const [reason, setReason] = useState('');
  const boat = snap.boats[0];
  const checklist = useMemo(
    () => runChecklist({ boat, sensors: snap.sensors, settings: snap.settings, waterBody: snap.waterBody, now, parameterName: (k) => snap.parameters.find((p) => p.key === k)?.name ?? k }),
    [boat, snap.sensors, snap.settings, snap.waterBody, snap.parameters, now],
  );

  async function start(override: boolean) {
    const r = await cmd.send('START_MISSION', { mission_id: missionId, ...(override ? { override_reason: reason } : {}) });
    if (r) onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title={`Start mission ${missionId}`}>
      <p className="mb-2 text-sm text-muted-foreground">Pre-mission checklist (checked again on the server when you press Start).</p>
      <ul className="space-y-1 text-sm">
        {checklist.items.map((i) => (
          <li key={i.key} className="flex items-start gap-2">
            {i.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-700" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700" aria-hidden />}
            <span>
              <span className="font-medium">{i.label}</span> <span className="sr-only">{i.ok ? 'pass' : 'fail'}</span>
              <span className="text-muted-foreground"> · {i.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      {checklist.passed ? (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void start(false)} disabled={cmd.busy}>Start mission</Button>
        </div>
      ) : isAdmin(user) ? (
        <div className="mt-4 space-y-2">
          <p className="text-sm">The checklist failed. As an admin you can override it; the reason is written to the audit log.</p>
          <Label htmlFor="override" className="block text-xs">Override reason (required)</Label>
          <textarea id="override" className="w-full rounded-md border border-input bg-card p-2 text-sm" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="destructive" onClick={() => void start(true)} disabled={cmd.busy || reason.trim().length < 5}>
              Start with override
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-2 text-sm">
          <p>
            The mission cannot start until every item passes. Fix the failing items (for example calibrate probes from the{' '}
            <Link to="/sensors" className="text-primary hover:underline">Sensors page</Link>) or ask an admin to override.
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
      {cmd.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {cmd.error.message}
        </p>
      )}
    </Dialog>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Crosshair, FlaskConical, Gamepad2, Home, OctagonX, Pause, Play, Square } from 'lucide-react';
import { COMMAND_LABEL, SAFETY_COMMANDS, linkLost } from '@shared/commands.ts';
import { distanceToEdgeM, pointInPolygon } from '@shared/geo.ts';
import type { CommandType, LatLon } from '@shared/types.ts';
import { canOperate, useData, useSnapshot } from '@/data/DataProvider';
import { activeMission } from '@/data/selectors';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/form';
import { useNow } from '@/lib/useNow';
import { cn } from '@/lib/utils';
import { CommandList } from './CommandList';
import { StartMissionDialog } from './StartMissionDialog';
import { useCommand } from './useCommand';

/** Large emergency stop: no confirmation dialog, sent immediately. */
export function EStopButton({ className, compact }: { className?: string; compact?: boolean }) {
  const { user } = useData();
  const cmd = useCommand();
  if (!canOperate(user)) return null;
  return (
    <div className={className}>
      <button
        onClick={() => void cmd.send('EMERGENCY_STOP')}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-lg border-2 border-red-900 bg-red-600 font-bold uppercase tracking-wide text-white shadow-lg hover:bg-red-700 focus-visible:ring-4 focus-visible:ring-red-300 active:bg-red-800',
          compact ? 'h-12 px-4 text-sm' : 'h-14 px-4 text-base',
        )}
        aria-label="Emergency stop: stop the boat now"
      >
        <OctagonX className="h-6 w-6" aria-hidden /> Emergency stop
      </button>
      {cmd.error && (
        <p role="alert" className="mt-1 rounded bg-card px-1 text-xs text-destructive">
          {cmd.error.message}
        </p>
      )}
    </div>
  );
}

export function BoatControls({ gotoTarget, gotoMode, setGotoMode, clearGoto }: { gotoTarget: LatLon | null; gotoMode: boolean; setGotoMode: (v: boolean) => void; clearGoto: () => void }) {
  const snap = useSnapshot();
  const { user } = useData();
  const now = useNow(1000);
  const cmd = useCommand();
  const [startId, setStartId] = useState<string | null>(null);
  const [manualConfirm, setManualConfirm] = useState(false);
  const boat = snap.boats[0];
  const mission = activeMission(snap);
  const sentMission = snap.missions.find((m) => m.status === 'sent');

  if (!boat) return null;
  if (!canOperate(user)) {
    return <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">Boat controls are available to operators and admins. You have read-only access.</p>;
  }

  const lost = linkLost(boat, now, snap.settings);
  const blocking = cmd.pending.find((c) => !SAFETY_COMMANDS.includes(c.type) && c.type !== 'MANUAL_DRIVE');
  const mode = boat.mode;
  const disabled = (type: CommandType) => cmd.busy || (!SAFETY_COMMANDS.includes(type) && (lost || !!blocking));

  return (
    <div className="space-y-3">
      <EStopButton />
      {lost && <p className="text-xs font-medium text-red-800 dark:text-red-200">Link lost: only Emergency stop and Return home can be sent. Boat following onboard failsafe.</p>}
      {blocking && !lost && <p className="text-xs text-muted-foreground">Waiting for the boat to confirm “{COMMAND_LABEL[blocking.type]}”; other controls are paused until then.</p>}

      <div className="grid grid-cols-2 gap-2">
        {mode === 'EMERGENCY_STOP' ? (
          <Button variant="outline" disabled={disabled('CLEAR_ESTOP')} onClick={() => void cmd.send('CLEAR_ESTOP')}>
            <Square className="h-4 w-4" aria-hidden /> Clear stop
          </Button>
        ) : mission?.status === 'running' ? (
          <Button variant="outline" disabled={disabled('PAUSE_MISSION')} onClick={() => void cmd.send('PAUSE_MISSION')}>
            <Pause className="h-4 w-4" aria-hidden /> Pause mission
          </Button>
        ) : mission?.status === 'paused' ? (
          <Button variant="outline" disabled={disabled('RESUME_MISSION') || mode !== 'IDLE'} onClick={() => void cmd.send('RESUME_MISSION')}>
            <Play className="h-4 w-4" aria-hidden /> Resume mission
          </Button>
        ) : (
          <Button variant="outline" disabled={!sentMission || disabled('START_MISSION') || mode !== 'IDLE'} onClick={() => sentMission && setStartId(sentMission.id)} title={sentMission ? `Start ${sentMission.id}` : 'Approve and send a mission first (Missions page)'}>
            <Play className="h-4 w-4" aria-hidden /> {sentMission ? `Start ${sentMission.id}` : 'Start mission'}
          </Button>
        )}
        <Button variant="outline" disabled={disabled('RETURN_HOME')} onClick={() => void cmd.send('RETURN_HOME')}>
          <Home className="h-4 w-4" aria-hidden /> Return home
        </Button>
        <Button variant="outline" disabled={disabled('TAKE_SAMPLE') || mode === 'EMERGENCY_STOP'} onClick={() => void cmd.send('TAKE_SAMPLE')}>
          <FlaskConical className="h-4 w-4" aria-hidden /> Sample here
        </Button>
        <Button
          variant={gotoMode ? 'default' : 'outline'}
          aria-pressed={gotoMode}
          disabled={disabled('GOTO') || mode === 'MANUAL' || mode === 'EMERGENCY_STOP' || mission?.status === 'running'}
          onClick={() => setGotoMode(!gotoMode)}
          title={mission?.status === 'running' ? 'Pause the mission first' : undefined}
        >
          <Crosshair className="h-4 w-4" aria-hidden /> {gotoMode ? 'Click the map…' : 'Go to point'}
        </Button>
        {mode === 'MANUAL' ? (
          <Button variant="outline" className="col-span-2" disabled={disabled('EXIT_MANUAL')} onClick={() => void cmd.send('EXIT_MANUAL')}>
            <Gamepad2 className="h-4 w-4" aria-hidden /> Leave manual mode
          </Button>
        ) : (
          <Button variant="outline" className="col-span-2" disabled={disabled('ENTER_MANUAL') || mode !== 'IDLE'} onClick={() => setManualConfirm(true)}>
            <Gamepad2 className="h-4 w-4" aria-hidden /> Manual mode…
          </Button>
        )}
      </div>

      {mode === 'MANUAL' && !lost && <ManualPad />}

      {cmd.error && (
        <p role="alert" className="text-sm text-destructive">
          Rejected: {cmd.error.message}
        </p>
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold">Commands</h3>
        <CommandList />
      </div>

      {startId && <StartMissionDialog missionId={startId} open onClose={() => setStartId(null)} />}

      <Dialog open={manualConfirm} onClose={() => setManualConfirm(false)} title="Enter manual mode?">
        <p className="text-sm">
          You will steer the boat directly. Speed is limited to {snap.settings.manual_max_speed_mps} m/s, the boat stops if no input arrives for {4} s, and it
          leaves manual mode by itself after {Math.round(snap.settings.manual_idle_timeout_s / 60)} minutes without input. The onboard geofence and obstacle
          avoidance stay active.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setManualConfirm(false)}>Cancel</Button>
          <Button
            onClick={() => {
              setManualConfirm(false);
              void cmd.send('ENTER_MANUAL');
            }}
          >
            Enter manual mode
          </Button>
        </div>
      </Dialog>

      <GotoDialog target={gotoTarget} onClose={clearGoto} onSend={async (t) => {
        const ok = await cmd.send('GOTO', { target: t });
        if (ok) clearGoto();
      }} error={cmd.error?.message ?? null} busy={cmd.busy} />
    </div>
  );
}

function GotoDialog({ target, onClose, onSend, error, busy }: { target: LatLon | null; onClose: () => void; onSend: (t: LatLon) => void; error: string | null; busy: boolean }) {
  const snap = useSnapshot();
  const wb = snap.waterBody;
  const inside = !!(target && wb && pointInPolygon(target, wb.geofence));
  const edge = target && wb ? distanceToEdgeM(target, wb.geofence) : 0;
  return (
    <Dialog open={!!target} onClose={onClose} title="Send the boat to this point?">
      {target && (
        <div className="space-y-2 text-sm">
          <p className="font-mono text-xs">
            {target[0].toFixed(6)}, {target[1].toFixed(6)}
          </p>
          {inside ? (
            <p>Inside the geofence, {Math.round(edge)} m from its edge. The boat will travel there at 0.8 m/s and hold position.</p>
          ) : (
            <p className="font-medium text-red-800 dark:text-red-200">This point is outside the geofence. The server will reject it; pick a point inside the dashed red line.</p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              Rejected: {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            {/* Sent even when outside so the server-side check is visible; it rejects with a reason. */}
            <Button onClick={() => onSend(target)} disabled={busy}>
              Confirm go to point
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

const DIRECTIONS: { label: string; heading: number; key?: string }[] = [
  { label: 'NW', heading: 315 },
  { label: 'N', heading: 0, key: 'ArrowUp' },
  { label: 'NE', heading: 45 },
  { label: 'W', heading: 270, key: 'ArrowLeft' },
  { label: '', heading: -1 },
  { label: 'E', heading: 90, key: 'ArrowRight' },
  { label: 'SW', heading: 225 },
  { label: 'S', heading: 180, key: 'ArrowDown' },
  { label: 'SE', heading: 135 },
];

/** Press-and-hold arrow pad. Each held direction sends a drive command every second; release stops. */
function ManualPad() {
  const snap = useSnapshot();
  const cmd = useCommand();
  const max = snap.settings.manual_max_speed_mps;
  const [speed, setSpeed] = useState(Math.min(0.5, max));
  const timer = useRef<number | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const drive = (heading: number, sp: number) => void cmd.send('MANUAL_DRIVE', { heading_deg: heading, speed_mps: sp });
  const start = (heading: number) => {
    stop(false);
    setActive(heading);
    drive(heading, speed);
    timer.current = window.setInterval(() => drive(heading, speed), 1000);
  };
  function stop(sendStop = true) {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
    if (sendStop && active != null) drive(active, 0);
    setActive(null);
  }
  useEffect(() => () => {
    if (timer.current != null) window.clearInterval(timer.current);
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = DIRECTIONS.find((x) => x.key === e.key);
    if (!d) return;
    e.preventDefault();
    if (e.type === 'keydown' && active !== d.heading) start(d.heading);
    if (e.type === 'keyup') stop();
  };

  return (
    <div className="rounded-md border p-3" onKeyDown={onKey} onKeyUp={onKey}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label htmlFor="mspeed" className="text-xs">
          Speed {speed.toFixed(1)} m/s (max {max})
        </Label>
        <input id="mspeed" type="range" min={0.1} max={max} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-32" />
      </div>
      <div className="mx-auto grid w-48 grid-cols-3 gap-1.5" role="group" aria-label="Manual drive pad: hold a direction, or use the arrow keys">
        {DIRECTIONS.map((d) =>
          d.heading < 0 ? (
            <button key="stop" onClick={() => stop()} className="flex h-14 items-center justify-center rounded-md border bg-secondary text-xs font-semibold" aria-label="Stop">
              STOP
            </button>
          ) : (
            <button
              key={d.label}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                start(d.heading);
              }}
              onPointerUp={() => stop()}
              onPointerCancel={() => stop()}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  drive(d.heading, speed);
                }
              }}
              className={cn('h-14 rounded-md border bg-card text-sm font-semibold touch-none select-none', active === d.heading && 'bg-primary text-primary-foreground')}
              aria-label={`Drive ${d.label} (heading ${d.heading}°)`}
            >
              {d.label}
            </button>
          ),
        )}
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">Hold a direction to drive; release to stop. Arrow keys work while the pad has focus.</p>
      {cmd.error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {cmd.error.message}
        </p>
      )}
    </div>
  );
}

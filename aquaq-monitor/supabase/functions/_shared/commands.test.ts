import { describe, expect, it } from 'vitest';
import { runChecklist, validateCommand, type CommandContext } from './commands.ts';
import { demoBoat, demoMission, demoSensors, demoWaterBody } from './demoLake.ts';
import { fromLocal } from './geo.ts';
import { DEFAULT_SETTINGS, type Boat } from './types.ts';

const NOW = Date.parse('2026-10-26T10:00:00+05:30');
const iso = new Date(NOW).toISOString();
const wb = demoWaterBody();
const origin: [number, number] = [12.9716, 79.1588];

function ctx(over: Partial<CommandContext> = {}, boat: Partial<Boat> = {}): CommandContext {
  return {
    role: 'operator',
    boat: { ...demoBoat(iso), mode: 'IDLE', last_seen: iso, ...boat },
    now: NOW,
    settings: DEFAULT_SETTINGS,
    waterBody: wb,
    pending: [],
    ...over,
  };
}

describe('command validation', () => {
  it('rejects Go to point outside the geofence', () => {
    const outside = fromLocal(origin, 0, 300); // north of the lake
    const r = validateCommand('GOTO', { target: outside }, ctx());
    expect(r).toEqual({ ok: false, reason: 'Target is outside the geofence.' });
    expect(validateCommand('GOTO', { target: fromLocal(origin, 0, 0) }, ctx()).ok).toBe(true);
  });

  it('rejects viewers', () => {
    expect(validateCommand('EMERGENCY_STOP', {}, ctx({ role: 'viewer' })).ok).toBe(false);
  });

  it('always allows emergency stop and return home for operators', () => {
    const busy = ctx({ pending: [{ id: 'c', boat_id: 'B1', type: 'GOTO', payload: {}, issued_by: 'u', issued_at: iso, status: 'pending', ack_at: null, done_at: null, result: null }] }, { mode: 'AUTO', last_seen: new Date(NOW - 600_000).toISOString() });
    expect(validateCommand('EMERGENCY_STOP', {}, busy).ok).toBe(true);
    expect(validateCommand('RETURN_HOME', {}, busy).ok).toBe(true);
    expect(validateCommand('TAKE_SAMPLE', {}, busy).ok).toBe(false);
  });

  it('disables other commands while the link is lost', () => {
    const r = validateCommand('TAKE_SAMPLE', {}, ctx({}, { last_seen: new Date(NOW - 61_000).toISOString() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/onboard failsafe/);
  });

  it('rejects commands that conflict with the mode', () => {
    const running = { ...demoMission(iso).mission, status: 'running' as const };
    expect(validateCommand('GOTO', { target: fromLocal(origin, 0, 0) }, ctx({ activeMission: running }, { mode: 'AUTO' })).ok).toBe(false);
    expect(validateCommand('ENTER_MANUAL', {}, ctx({}, { mode: 'AUTO' })).ok).toBe(false);
    expect(validateCommand('MANUAL_DRIVE', { heading_deg: 90, speed_mps: 0.5 }, ctx({}, { mode: 'IDLE' })).ok).toBe(false);
    expect(validateCommand('MANUAL_DRIVE', { heading_deg: 90, speed_mps: 1.5 }, ctx({}, { mode: 'MANUAL' })).ok).toBe(false);
    expect(validateCommand('MANUAL_DRIVE', { heading_deg: 90, speed_mps: 1.0 }, ctx({}, { mode: 'MANUAL' })).ok).toBe(true);
    expect(validateCommand('PAUSE_MISSION', {}, ctx({ activeMission: running }, { mode: 'AUTO' })).ok).toBe(true);
    expect(validateCommand('TAKE_SAMPLE', {}, ctx({}, { mode: 'EMERGENCY_STOP' })).ok).toBe(false);
    expect(validateCommand('CLEAR_ESTOP', {}, ctx({}, { mode: 'EMERGENCY_STOP' })).ok).toBe(true);
  });

  it('needs an approved mission to send and a passed checklist (or admin override) to start', () => {
    const m = demoMission(iso).mission;
    expect(validateCommand('LOAD_MISSION', { mission_id: m.id }, ctx({ mission: { ...m, status: 'proposed' } })).ok).toBe(false);
    expect(validateCommand('LOAD_MISSION', { mission_id: m.id }, ctx({ mission: { ...m, status: 'approved' } })).ok).toBe(true);
    const sent = { ...m, status: 'sent' as const };
    const failed = { passed: false, items: [] };
    expect(validateCommand('START_MISSION', { mission_id: m.id }, ctx({ mission: sent, checklist: failed })).ok).toBe(false);
    expect(validateCommand('START_MISSION', { mission_id: m.id }, ctx({ role: 'admin', mission: sent, checklist: failed })).ok).toBe(false);
    expect(validateCommand('START_MISSION', { mission_id: m.id, override_reason: 'Spare DO probe fitted, checked by hand' }, ctx({ role: 'admin', mission: sent, checklist: failed })).ok).toBe(true);
    expect(validateCommand('START_MISSION', { mission_id: m.id }, ctx({ mission: sent, checklist: { passed: true, items: [] } })).ok).toBe(true);
  });
});

describe('pre-mission checklist', () => {
  it('fails on an overdue probe and low battery, passes when fixed', () => {
    const boat = { ...demoBoat(iso), battery_pct: 70, last_seen: iso };
    const r = runChecklist({ boat, sensors: demoSensors(NOW), settings: DEFAULT_SETTINGS, waterBody: wb, now: NOW });
    expect(r.passed).toBe(false);
    expect(r.items.find((i) => i.key === 'probe:B1-do')!.ok).toBe(false); // 20 days since calibration
    expect(r.items.find((i) => i.key === 'battery')!.ok).toBe(false);
    expect(r.items.find((i) => i.key === 'link')!.ok).toBe(true);
    expect(r.items.find((i) => i.key === 'geofence')!.ok).toBe(true);
    const fixed = runChecklist({ boat: { ...boat, battery_pct: 92 }, sensors: demoSensors(NOW).map((s) => ({ ...s, last_calibrated_at: iso })), settings: DEFAULT_SETTINGS, waterBody: wb, now: NOW });
    expect(fixed.passed).toBe(true);
  });
});

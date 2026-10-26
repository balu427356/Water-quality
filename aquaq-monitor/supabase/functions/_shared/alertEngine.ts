// Alert rule engine (section 7). Pure and deterministic: it takes the current context,
// the new readings since the last run and its own memory, and returns the alert list
// with new and merged alerts. Runs in the browser demo and in the `alerts` Edge Function.

import { distanceToEdgeM, pointInPolygon } from './geo.ts';
import { TIER_ORDER, formatLimit, limitRatio, limitStatus, round } from './limits.ts';
import type {
  Alert,
  AlertRule,
  AlertRuleId,
  AlertSeverity,
  Boat,
  Mission,
  Parameter,
  Reading,
  RiskTier,
  Sensor,
  Settings,
  Station,
  Survey,
  WaterBody,
  Zone,
  ZoneScore,
} from './types.ts';

export const SEVERITY_ORDER: AlertSeverity[] = ['info', 'warning', 'high', 'critical'];
export const maxSeverity = (a: AlertSeverity, b: AlertSeverity) =>
  SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;

/** Number of fault confirmations in a row before a sensor gets a maintenance flag (section 6.6). */
export const FAULT_STREAK_FOR_MAINTENANCE = 3;

const rule = (
  id: AlertRuleId,
  name: string,
  description: string,
  severity: AlertSeverity,
  cooldown_minutes: number,
  channels: AlertRule['channels'] = ['in_app', 'push'],
): AlertRule => ({ id, name, enabled: true, condition: { description }, severity, channels, cooldown_minutes });

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  rule('limit_exceeded', 'Limit exceeded', 'Trusted reading (T ≥ threshold) outside its safe limit. Critical above 2× the limit or in a Critical-tier zone.', 'high', 30, ['in_app', 'push', 'email', 'sms']),
  rule('near_limit', 'Near limit', 'Trusted reading inside the limit but within the near-limit band.', 'warning', 60, ['in_app']),
  rule('possible_sensor_fault', 'Possible sensor fault', 'Anomaly with trust T below the threshold. Never reported as pollution.', 'warning', 60, ['in_app', 'push']),
  rule('confirmed_pollution', 'Confirmed pollution', 'A confirmation sample confirms an earlier anomaly.', 'high', 30, ['in_app', 'push', 'email', 'sms']),
  rule('fault_confirmed', 'Fault confirmed', 'A confirmation sample does not confirm an earlier anomaly; counts toward a maintenance flag.', 'info', 0, ['in_app']),
  rule('zone_tier_rose', 'Zone tier rose', 'A zone moved up a risk tier since the previous survey.', 'high', 0, ['in_app', 'push', 'email']),
  rule('station_trigger', 'Station trigger', 'A fixed station reports a trusted exceedance between surveys; an early mission is proposed.', 'high', 60, ['in_app', 'push', 'email']),
  rule('low_battery', 'Low battery', 'Boat battery below the return level; the boat returns home by itself.', 'high', 30),
  rule('link_lost', 'Link lost', 'No boat telemetry for longer than the link-loss timeout.', 'critical', 5, ['in_app', 'push', 'sms']),
  rule('geofence', 'Geofence', 'Boat within the warning distance of the geofence (warning) or outside it (critical).', 'warning', 10),
  rule('command_failed', 'Command failed', 'A boat command times out or fails (active from Phase 3).', 'warning', 0),
  rule('fallback_used', 'Fallback used', 'The planner used the classical fallback instead of a quantum solver.', 'info', 0, ['in_app']),
  rule('calibration_due', 'Calibration due', 'Sensor not calibrated within the calibration interval.', 'warning', 24 * 60, ['in_app', 'email']),
];

export interface PendingConfirmation {
  zone_id: string;
  parameter_key: string;
  sensor_id: string | null;
  value: number;
  trust_T: number;
  since: string;
}

export interface EngineMemory {
  /** Condition-type rules that are currently true, so they fire on the transition only. */
  active: Record<string, boolean>;
  /** Low-trust anomalies waiting for a confirmation sample, keyed zone|parameter. */
  pending: Record<string, PendingConfirmation>;
  /** Consecutive fault confirmations per sensor id. */
  faultStreak: Record<string, number>;
  /** When an alert was last created for a dedup key (ms), for cooldowns. */
  lastFired: Record<string, number>;
  /** One-shot events already handled (tier rise per survey, fallback per mission). */
  done: Record<string, true>;
}

export const emptyMemory = (): EngineMemory => ({ active: {}, pending: {}, faultStreak: {}, lastFired: {}, done: {} });

export interface EngineContext {
  now: number;
  settings: Settings;
  rules: AlertRule[];
  parameters: Parameter[];
  zones: Zone[];
  stations: Station[];
  sensors: Sensor[];
  boats: Boat[];
  surveys: Survey[];
  zoneScores: ZoneScore[];
  missions: Mission[];
  waterBody: WaterBody | null;
}

export type Candidate = Pick<
  Alert,
  'rule_id' | 'dedup_key' | 'severity' | 'category' | 'title' | 'message' | 'suggested_action' | 'zone_id' | 'source_id' | 'parameter_key' | 'value' | 'limit_text' | 'action'
>;

export interface EngineResult {
  alerts: Alert[];
  created: Alert[];
  merged: Alert[];
  memory: EngineMemory;
  /** Sensors to update (maintenance flag set by repeated fault confirmations). */
  sensorUpdates: { id: string; maintenance_flag: boolean }[];
}

// ------------------------------------------------------------------ helpers

function latestTiers(ctx: EngineContext): { current: Record<string, RiskTier>; previous: Record<string, RiskTier>; surveyId: string | null } {
  const done = ctx.surveys.filter((s) => s.status === 'completed').sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  const pick = (id: string | undefined) => {
    const out: Record<string, RiskTier> = {};
    for (const z of ctx.zoneScores) if (z.survey_id === id) out[z.zone_id] = z.risk_tier;
    return out;
  };
  const cur = done[done.length - 1];
  return { current: pick(cur?.id), previous: pick(done[done.length - 2]?.id), surveyId: cur?.id ?? null };
}

const zoneLabel = (ctx: EngineContext, zoneId: string | null) => {
  const z = ctx.zones.find((x) => x.id === zoneId);
  return z ? `zone ${z.code} (${z.name})` : 'an unmapped area';
};

const sourceLabel = (ctx: EngineContext, r: Reading) => {
  if (r.source_type === 'station') return ctx.stations.find((s) => s.id === r.source_id)?.name ?? r.source_id;
  if (r.source_type === 'lab') return 'Lab sample';
  return ctx.boats.find((b) => b.id === r.source_id)?.name ?? r.source_id;
};

function direction(value: number, p: Parameter): string {
  if (p.limit_type === 'max') return 'above';
  if (p.limit_type === 'min') return 'below';
  return p.limit_low != null && value < p.limit_low ? 'below' : 'above';
}

const fmtVal = (v: number, p: Parameter) => `${round(v, 2)} ${p.unit}`;

// ------------------------------------------------------------------ rule evaluation

/** Evaluate all rules and return candidate alerts (before dedup and cooldown). */
export function evaluate(ctx: EngineContext, prev: EngineMemory, readings: Reading[]): { candidates: Candidate[]; memory: EngineMemory; sensorUpdates: EngineResult['sensorUpdates'] } {
  const memory: EngineMemory = {
    active: { ...prev.active },
    pending: { ...prev.pending },
    faultStreak: { ...prev.faultStreak },
    lastFired: { ...prev.lastFired },
    done: { ...prev.done },
  };
  const out: Candidate[] = [];
  const sensorUpdates: EngineResult['sensorUpdates'] = [];
  const s = ctx.settings;
  const thr = s.trust_threshold;
  const tiers = latestTiers(ctx);

  // ---- readings
  for (const r of readings) {
    const p = ctx.parameters.find((x) => x.key === r.parameter_key);
    if (!p || !p.enabled || p.limit_type === 'none') continue;
    const status = limitStatus(r.value, p, s.near_limit_pct);
    const ratio = limitRatio(r.value, p) ?? 0;
    const zoneTier = r.zone_id ? tiers.current[r.zone_id] : undefined;
    const where = zoneLabel(ctx, r.zone_id);
    const src = sourceLabel(ctx, r);
    const limit = formatLimit(p);
    const T = r.trust_T;
    const trusted = T == null || T >= thr;
    const sensor = ctx.sensors.find((x) => x.owner_id === r.source_id && x.parameter_key === r.parameter_key) ?? null;
    const base = { zone_id: r.zone_id, source_id: r.source_id, parameter_key: p.key, value: r.value, limit_text: limit, action: null };

    // Confirmation sample answering a pending low-trust anomaly.
    const pendKey = `${r.zone_id}|${p.key}`;
    const pend = r.confirmation ? memory.pending[pendKey] : undefined;
    if (pend) {
      delete memory.pending[pendKey];
      const sensorId = pend.sensor_id;
      if (status === 'out' && trusted) {
        if (sensorId) memory.faultStreak[sensorId] = 0;
        const critical = ratio > 2 || zoneTier === 'Critical';
        out.push({
          ...base,
          rule_id: 'confirmed_pollution',
          dedup_key: `confirmed_pollution|${r.zone_id}|${p.key}`,
          severity: critical ? 'critical' : 'high',
          category: 'water_quality',
          title: `Confirmed pollution: ${p.name} in ${where}`,
          message: `The confirmation sample read ${fmtVal(r.value, p)}, ${direction(r.value, p)} the safe limit (${limit}), confirming the earlier anomaly of ${fmtVal(pend.value, p)} (trust ${pend.trust_T}).${ratio > 2 ? ' More than twice the limit.' : ''}`,
          suggested_action: 'Notify the responsible authority, plan dense or hotspot sampling around the location, and look for the source.',
        });
      } else {
        const streak = sensorId ? (memory.faultStreak[sensorId] ?? 0) + 1 : 0;
        if (sensorId) memory.faultStreak[sensorId] = streak;
        const flag = sensorId != null && streak >= FAULT_STREAK_FOR_MAINTENANCE;
        if (flag) sensorUpdates.push({ id: sensorId!, maintenance_flag: true });
        out.push({
          ...base,
          rule_id: 'fault_confirmed',
          dedup_key: `fault_confirmed|${sensorId ?? r.source_id}|${p.key}`,
          severity: 'info',
          category: 'sensor',
          title: `Sensor fault confirmed: ${p.name} probe on ${src}`,
          message: `The confirmation sample read ${fmtVal(r.value, p)} (limit ${limit}), so the earlier reading of ${fmtVal(pend.value, p)} in ${where} was not real pollution. ${
            sensorId ? `Failed confirmation checks in a row for this probe: ${streak} of ${FAULT_STREAK_FOR_MAINTENANCE}.` : ''
          }${flag ? ' Maintenance flag set.' : ''}`,
          suggested_action: flag ? 'Recalibrate or replace the probe before the next mission.' : 'Check the probe at the next dock visit.',
        });
      }
      continue;
    }

    // Low-trust anomaly: a likely sensor fault, never reported as pollution.
    if (r.edge_anomaly_flag && T != null && T < thr) {
      if (r.zone_id) {
        memory.pending[pendKey] ??= { zone_id: r.zone_id, parameter_key: p.key, sensor_id: sensor?.id ?? null, value: r.value, trust_T: T, since: r.ts };
      }
      out.push({
        ...base,
        rule_id: 'possible_sensor_fault',
        dedup_key: `possible_sensor_fault|${r.zone_id}|${p.key}|${r.source_id}`,
        severity: 'warning',
        category: 'sensor',
        title: 'Possible sensor fault: confirmation sample planned',
        message: `${src} ${p.name} probe read ${fmtVal(r.value, p)} in ${where} (limit ${limit}), but trust is only ${T} (threshold ${thr}). It is treated as a likely sensor fault, and no water-quality alert is raised, until a confirmation sample is taken.`,
        suggested_action: 'Wait for the confirmation sample. Check the probe’s calibration and fouling.',
      });
      continue;
    }

    if (status === 'out' && trusted) {
      if (r.source_type === 'station') {
        out.push({
          ...base,
          action: 'propose_early_mission',
          rule_id: 'station_trigger',
          dedup_key: `station_trigger|${r.zone_id}|${p.key}|${r.source_id}`,
          severity: maxSeverity('high', ruleSeverity(ctx, 'station_trigger')),
          category: 'water_quality',
          title: `${src}: ${p.name} ${direction(r.value, p)} limit between surveys`,
          message: `${src} measured ${fmtVal(r.value, p)} in ${where}; safe limit ${limit}${T != null ? `, trust ${T}` : ''}. An early survey mission is proposed for this zone.`,
          suggested_action: 'Review the station trend and approve an early mission for this zone.',
        });
      } else {
        const critical = ratio > 2 || zoneTier === 'Critical';
        out.push({
          ...base,
          rule_id: 'limit_exceeded',
          dedup_key: `limit_exceeded|${r.zone_id}|${p.key}`,
          severity: critical ? 'critical' : ruleSeverity(ctx, 'limit_exceeded'),
          category: 'water_quality',
          title: `${p.name} ${direction(r.value, p)} safe limit in ${where}`,
          message: `${src} measured ${fmtVal(r.value, p)}; safe limit ${limit}${T != null ? `, trust ${T}` : ''}.${ratio > 2 ? ' More than twice the limit.' : ''}${
            zoneTier === 'Critical' ? ' The zone is already in the Critical tier.' : ''
          }`,
          suggested_action: 'Check the zone on the live map, inform the maintenance team and plan dense sampling to locate the source.',
        });
      }
      continue;
    }

    if (status === 'near' && trusted) {
      out.push({
        ...base,
        rule_id: 'near_limit',
        dedup_key: `near_limit|${r.zone_id}|${p.key}`,
        severity: ruleSeverity(ctx, 'near_limit'),
        category: 'water_quality',
        title: `${p.name} near limit in ${where}`,
        message: `${src} measured ${fmtVal(r.value, p)}, within ${s.near_limit_pct}% of the safe limit (${limit}).`,
        suggested_action: 'Watch the trend. No action is needed unless it keeps moving toward the limit.',
      });
    }
  }

  // ---- boat state
  for (const b of ctx.boats) {
    const age = b.last_seen ? (ctx.now - new Date(b.last_seen).getTime()) / 1000 : Infinity;
    const lostKey = `link_lost|${b.id}`;
    if (age > s.link_loss_timeout_s) {
      if (!memory.active[lostKey]) {
        memory.active[lostKey] = true;
        out.push({
          rule_id: 'link_lost',
          dedup_key: lostKey,
          severity: 'critical',
          category: 'boat',
          title: `Link lost: no telemetry from ${b.name}`,
          message: `No telemetry for ${Math.round(age)} s (timeout ${s.link_loss_timeout_s} s). Boat following onboard failsafe; controls are disabled until the link returns.`,
          suggested_action: 'Check the 4G/satellite link and the gateway. Watch for the boat to reappear; send someone to the shore if it does not.',
          zone_id: null, source_id: b.id, parameter_key: null, value: Math.round(age), limit_text: `${s.link_loss_timeout_s} s`, action: null,
        });
      }
      continue; // the rest of the boat state is stale while the link is down
    }
    memory.active[lostKey] = false;

    const battKey = `low_battery|${b.id}`;
    if (b.battery_pct < s.low_battery_return_pct) {
      if (!memory.active[battKey]) {
        memory.active[battKey] = true;
        out.push({
          rule_id: 'low_battery',
          dedup_key: battKey,
          severity: ruleSeverity(ctx, 'low_battery'),
          category: 'boat',
          title: `Low battery: ${b.name} returning to dock`,
          message: `Battery at ${Math.round(b.battery_pct)}%, below the ${s.low_battery_return_pct}% return level. The boat's onboard failsafe is returning it to the dock by itself.`,
          suggested_action: 'No command needed. Check the charging and solar panel once it docks.',
          zone_id: null, source_id: b.id, parameter_key: null, value: round(b.battery_pct, 1), limit_text: `${s.low_battery_return_pct}%`, action: null,
        });
      }
    } else if (b.battery_pct >= s.low_battery_return_pct + 5) {
      memory.active[battKey] = false; // hysteresis so charging near the threshold does not flap
    }

    const wb = ctx.waterBody;
    if (wb && b.position) {
      const inside = pointInPolygon(b.position, wb.geofence);
      const d = distanceToEdgeM(b.position, wb.geofence);
      const outKey = `geofence|${b.id}|outside`;
      const nearKey = `geofence|${b.id}|near`;
      if (!inside) {
        if (!memory.active[outKey]) {
          memory.active[outKey] = true;
          out.push({
            rule_id: 'geofence', dedup_key: outKey, severity: 'critical', category: 'boat',
            title: `${b.name} is outside the geofence`,
            message: `The boat is ${Math.round(d)} m outside the geofence. Its onboard geofence should bring it back.`,
            suggested_action: 'Watch the boat. If it does not return, send Return home (Phase 3) or an emergency stop.',
            zone_id: null, source_id: b.id, parameter_key: null, value: round(d, 1), limit_text: 'inside geofence', action: null,
          });
        }
      } else memory.active[outKey] = false;
      if (inside && d < s.geofence_warning_m) {
        if (!memory.active[nearKey]) {
          memory.active[nearKey] = true;
          out.push({
            rule_id: 'geofence', dedup_key: nearKey, severity: maxSeverity('warning', ruleSeverity(ctx, 'geofence')), category: 'boat',
            title: `${b.name} within ${s.geofence_warning_m} m of the geofence`,
            message: `The boat is ${round(d, 1)} m from the geofence edge.`,
            suggested_action: 'Check the planned route stays clear of the edge.',
            zone_id: null, source_id: b.id, parameter_key: null, value: round(d, 1), limit_text: `${s.geofence_warning_m} m`, action: null,
          });
        }
      } else if (!inside || d >= s.geofence_warning_m + 5) memory.active[nearKey] = false;
    }
  }

  // ---- calibration
  for (const sn of ctx.sensors) {
    const key = `calibration_due|${sn.id}`;
    const days = (ctx.now - new Date(sn.last_calibrated_at).getTime()) / 86_400_000;
    if (days > s.calibration_due_days) {
      if (!memory.active[key]) {
        memory.active[key] = true;
        const p = ctx.parameters.find((x) => x.key === sn.parameter_key);
        const owner = ctx.boats.find((b) => b.id === sn.owner_id)?.name ?? ctx.stations.find((st) => st.id === sn.owner_id)?.name ?? sn.owner_id;
        out.push({
          rule_id: 'calibration_due', dedup_key: key, severity: ruleSeverity(ctx, 'calibration_due'), category: 'sensor',
          title: `Calibration due: ${p?.name ?? sn.parameter_key} probe on ${owner}`,
          message: `Last calibrated ${Math.floor(days)} days ago (interval ${s.calibration_due_days} days). Readings from this probe may drift.`,
          suggested_action: 'Calibrate the probe before the next mission.',
          zone_id: null, source_id: sn.owner_id, parameter_key: sn.parameter_key, value: Math.floor(days), limit_text: `${s.calibration_due_days} days`, action: null,
        });
      }
    } else memory.active[key] = false;
  }

  // ---- zone tier rose since the previous survey (once per survey and zone)
  if (tiers.surveyId) {
    for (const [zoneId, tier] of Object.entries(tiers.current)) {
      const before = tiers.previous[zoneId];
      const key = `zone_tier_rose|${tiers.surveyId}|${zoneId}`;
      if (before && TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(before) && !memory.done[key]) {
        memory.done[key] = true;
        const score = ctx.zoneScores.find((z) => z.survey_id === tiers.surveyId && z.zone_id === zoneId);
        const lowTrust = score && score.trust_T < thr;
        out.push({
          rule_id: 'zone_tier_rose', dedup_key: key, severity: ruleSeverity(ctx, 'zone_tier_rose'), category: 'water_quality',
          title: `Zone ${ctx.zones.find((z) => z.id === zoneId)?.code ?? zoneId} risk rose from ${before} to ${tier}`,
          message: `Survey ${tiers.surveyId} moved ${zoneLabel(ctx, zoneId)} from ${before} to ${tier}${score ? ` (R ${score.risk_R}, T ${score.trust_T})` : ''}.${
            lowTrust ? ' Trust is low, so the zone is in lab review and a confirmation sample comes first.' : ''
          }`,
          suggested_action: lowTrust ? 'Wait for the confirmation sample before acting on this change.' : 'Review the zone details and plan denser sampling in the next mission.',
          zone_id: zoneId, source_id: null, parameter_key: null, value: score?.risk_R ?? null, limit_text: null, action: null,
        });
      }
    }
  }

  // ---- planner used the classical fallback (once per mission)
  for (const m of ctx.missions) {
    const key = `fallback_used|${m.id}`;
    if (m.solver === 'classical_fallback' && !memory.done[key]) {
      memory.done[key] = true;
      out.push({
        rule_id: 'fallback_used', dedup_key: key, severity: 'info', category: 'mission',
        title: `Mission ${m.id} planned with the classical fallback`,
        message: 'The quantum solver was not used for this plan; the classical fallback produced it. The plan is still valid.',
        suggested_action: 'No action needed. Check the planner service if this keeps happening.',
        zone_id: null, source_id: m.id, parameter_key: null, value: null, limit_text: null, action: null,
      });
    }
  }

  const enabled = new Set(ctx.rules.filter((r) => r.enabled).map((r) => r.id));
  return { candidates: out.filter((c) => enabled.has(c.rule_id)), memory, sensorUpdates };
}

function ruleSeverity(ctx: EngineContext, id: AlertRuleId): AlertSeverity {
  return ctx.rules.find((r) => r.id === id)?.severity ?? DEFAULT_ALERT_RULES.find((r) => r.id === id)!.severity;
}

// ------------------------------------------------------------------ dedup, cooldown, escalation

/**
 * Merge candidates into the alert list. A candidate with an unresolved alert of the same
 * dedup key increments that alert's count; otherwise a new alert is created unless the
 * rule's cooldown since the last alert for that key has not passed.
 */
export function applyCandidates(
  alerts: Alert[],
  candidates: Candidate[],
  rules: AlertRule[],
  memory: EngineMemory,
  now: number,
  newId: () => string,
): { alerts: Alert[]; created: Alert[]; merged: Alert[]; memory: EngineMemory } {
  const list = [...alerts];
  const created: Alert[] = [];
  const mergedIds = new Set<string>();
  const lastFired = { ...memory.lastFired };
  const nowIso = new Date(now).toISOString();

  for (const c of candidates) {
    const idx = list.findIndex((a) => a.dedup_key === c.dedup_key && a.status !== 'resolved');
    if (idx >= 0) {
      const a = list[idx];
      // Keep the text of the most severe occurrence so the message always explains the severity.
      const atLeast = SEVERITY_ORDER.indexOf(c.severity) >= SEVERITY_ORDER.indexOf(a.severity);
      list[idx] = {
        ...a,
        count: a.count + 1,
        updated_at: nowIso,
        severity: maxSeverity(a.severity, c.severity),
        ...(atLeast ? { title: c.title, message: c.message, value: c.value } : {}),
      };
      mergedIds.add(a.id);
      continue;
    }
    const cooldownMs = (rules.find((r) => r.id === c.rule_id)?.cooldown_minutes ?? 0) * 60_000;
    const last = lastFired[c.dedup_key];
    if (last != null && now - last < cooldownMs) continue;
    const alert: Alert = {
      ...c,
      id: newId(),
      created_at: nowIso,
      updated_at: nowIso,
      status: 'open',
      acknowledged_by: null,
      acknowledged_at: null,
      resolved_by: null,
      resolved_at: null,
      resolution_note: null,
      count: 1,
      escalated_at: null,
      escalation_count: 0,
    };
    list.unshift(alert);
    created.push(alert);
    lastFired[c.dedup_key] = now;
  }
  const merged = list.filter((a) => mergedIds.has(a.id) && !created.some((x) => x.id === a.id));
  return { alerts: list, created, merged, memory: { ...memory, lastFired } };
}

/** Critical alerts still open (not acknowledged) after `minutes` are re-sent; repeats every interval. */
export function escalate(alerts: Alert[], now: number, minutes: number): { alerts: Alert[]; escalated: Alert[] } {
  const escalated: Alert[] = [];
  const ms = minutes * 60_000;
  const next = alerts.map((a) => {
    if (a.severity !== 'critical' || a.status !== 'open') return a;
    const since = new Date(a.escalated_at ?? a.created_at).getTime();
    if (now - since < ms) return a;
    const e = { ...a, escalated_at: new Date(now).toISOString(), escalation_count: a.escalation_count + 1 };
    escalated.push(e);
    return e;
  });
  return { alerts: next, escalated };
}

/** One full engine pass: evaluate rules, merge into the alert list, escalate. */
export function runEngine(
  ctx: EngineContext,
  memory: EngineMemory,
  alerts: Alert[],
  readings: Reading[],
  newId: () => string,
): EngineResult & { escalated: Alert[] } {
  const ev = evaluate(ctx, memory, readings);
  const ap = applyCandidates(alerts, ev.candidates, ctx.rules, ev.memory, ctx.now, newId);
  const es = escalate(ap.alerts, ctx.now, ctx.settings.escalation_minutes);
  return { alerts: es.alerts, created: ap.created, merged: ap.merged, memory: ap.memory, sensorUpdates: ev.sensorUpdates, escalated: es.escalated };
}

// ------------------------------------------------------------------ workflow

export function acknowledge(a: Alert, userId: string, now: number): Alert {
  if (a.status !== 'open') throw new Error('Only open alerts can be acknowledged.');
  return { ...a, status: 'acknowledged', acknowledged_by: userId, acknowledged_at: new Date(now).toISOString() };
}

export function resolve(a: Alert, userId: string, note: string, now: number): Alert {
  if (a.status === 'resolved') throw new Error('This alert is already resolved.');
  if (!note.trim()) throw new Error('A resolution note is required.');
  const t = new Date(now).toISOString();
  return {
    ...a,
    status: 'resolved',
    acknowledged_by: a.acknowledged_by ?? userId,
    acknowledged_at: a.acknowledged_at ?? t,
    resolved_by: userId,
    resolved_at: t,
    resolution_note: note.trim(),
  };
}

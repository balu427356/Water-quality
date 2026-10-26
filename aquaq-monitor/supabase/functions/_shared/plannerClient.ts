// Typed client for the mission planner service (POST /plan, section 9).
// Mock: the in-app mock planner. Remote: an HTTP planner (e.g. the Python QAOA/annealing
// service). In the browser the remote client sends no API key; with Supabase the
// `operations` Edge Function calls the planner with the key kept server-side.

import { mockPlan, type PlannerRequest, type PlannerResponse } from './planner.ts';
import { scoreSurvey, type ScoreRequest, type ScoreResponse } from './scoring.ts';
import type { RiskTier, Solver } from './types.ts';

export interface PlannerClient {
  readonly label: string;
  plan(req: PlannerRequest): Promise<PlannerResponse>;
}

/** Zone scoring (POST /score) lives on the same service as the planner. */
export interface ScoringClient {
  readonly label: string;
  score(req: ScoreRequest): Promise<ScoreResponse>;
}

export class MockScoringClient implements ScoringClient {
  readonly label = 'In-app scoring (classical_v1)';
  async score(req: ScoreRequest): Promise<ScoreResponse> {
    return scoreSurvey(req);
  }
}

export class MockPlannerClient implements PlannerClient {
  readonly label = 'Mock planner (in app)';
  async plan(req: PlannerRequest): Promise<PlannerResponse> {
    return { ...mockPlan(req), waypoints: [] };
  }
}

const SOLVERS: Solver[] = ['quantum_qaoa', 'quantum_annealer', 'classical_fallback', 'mock'];

export class HttpPlannerClient implements PlannerClient, ScoringClient {
  readonly label: string;
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 20_000,
    /** Only ever passed on the server; the browser client sends no key. */
    private readonly apiKey?: string,
  ) {
    this.label = `Planner service at ${baseUrl}`;
  }
  async plan(req: PlannerRequest): Promise<PlannerResponse> {
    return parsePlannerResponse(await this.post('/plan', req), req);
  }

  async score(req: ScoreRequest): Promise<ScoreResponse> {
    return parseScoreResponse(await this.post('/score', req), req);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Planner service ${path} returned HTTP ${res.status}.`);
      return await res.json();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error(`Planner service ${path} did not answer within ${this.timeoutMs / 1000} s.`);
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(t);
    }
  }
}

const TIERS: RiskTier[] = ['Low', 'Medium', 'High', 'Critical'];

/** Validate an untrusted /score response. */
export function parseScoreResponse(raw: unknown, req: ScoreRequest): ScoreResponse {
  const r = raw as Partial<ScoreResponse>;
  if (!r || !Array.isArray(r.zone_scores)) throw new Error('Score response has no zone_scores.');
  const ids = new Set(req.zones);
  for (const z of r.zone_scores) {
    if (!ids.has(z.zone_id)) throw new Error(`Score response has unknown zone ${z.zone_id}.`);
    for (const k of ['risk_R', 'trust_T'] as const) {
      if (typeof z[k] !== 'number' || z[k] < 0 || z[k] > 1) throw new Error(`Score for zone ${z.zone_id} has ${k} outside 0–1.`);
    }
    if (!TIERS.includes(z.risk_tier)) throw new Error(`Score for zone ${z.zone_id} has unknown tier ${z.risk_tier}.`);
    if (z.trust_gate !== 'auto_accept' && z.trust_gate !== 'lab_review') throw new Error(`Score for zone ${z.zone_id} has unknown trust gate.`);
  }
  return { survey_id: req.survey_id, method: String(r.method ?? 'unknown'), zone_scores: r.zone_scores };
}

/** Validate an untrusted planner response against the contract. */
export function parsePlannerResponse(raw: unknown, req: PlannerRequest): PlannerResponse {
  const r = raw as Partial<PlannerResponse>;
  if (!r || typeof r !== 'object') throw new Error('Planner response is not an object.');
  if (!SOLVERS.includes(r.solver as Solver)) throw new Error(`Planner reported an unknown solver "${String(r.solver)}".`);
  if (!Array.isArray(r.zones)) throw new Error('Planner response has no zones.');
  const ids = new Set(req.zones.map((z) => z.zone_id));
  for (const z of r.zones) {
    if (!ids.has(z.zone_id)) throw new Error(`Planner returned unknown zone ${z.zone_id}.`);
    if (!(z.level in req.levels)) throw new Error(`Planner returned unknown level ${z.level}.`);
  }
  const energy = r.zones.reduce((s, z) => s + req.levels[z.level], 0);
  if (energy > req.energy_budget) throw new Error(`Planner plan uses ${energy} energy units, over the budget of ${req.energy_budget}.`);
  return {
    solver: r.solver as Solver,
    energy_planned: energy,
    objective: Number(r.objective ?? 0),
    zones: r.zones.map((z) => ({ zone_id: z.zone_id, level: z.level, energy: req.levels[z.level], reason: String(z.reason ?? '') })),
    waypoints: Array.isArray(r.waypoints) ? r.waypoints : [],
    note: r.note,
  };
}

export function plannerClientFor(mode: 'mock' | 'remote', url: string, apiKey?: string): PlannerClient {
  return mode === 'remote' && url ? new HttpPlannerClient(url, 60_000, apiKey) : new MockPlannerClient();
}

export function scoringClientFor(mode: 'mock' | 'remote', url: string, apiKey?: string): ScoringClient {
  return mode === 'remote' && url ? new HttpPlannerClient(url, 30_000, apiKey) : new MockScoringClient();
}

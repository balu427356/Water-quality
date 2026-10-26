// Typed client for the mission planner service (POST /plan, section 9).
// Mock: the in-app mock planner. Remote: an HTTP planner (e.g. the Python QAOA/annealing
// service). In the browser the remote client sends no API key; with Supabase the
// `operations` Edge Function calls the planner with the key kept server-side.

import { mockPlan, type PlannerRequest, type PlannerResponse } from './planner.ts';
import type { Solver } from './types.ts';

export interface PlannerClient {
  readonly label: string;
  plan(req: PlannerRequest): Promise<PlannerResponse>;
}

export class MockPlannerClient implements PlannerClient {
  readonly label = 'Mock planner (in app)';
  async plan(req: PlannerRequest): Promise<PlannerResponse> {
    return { ...mockPlan(req), waypoints: [] };
  }
}

const SOLVERS: Solver[] = ['quantum_qaoa', 'quantum_annealer', 'classical_fallback', 'mock'];

export class HttpPlannerClient implements PlannerClient {
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
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Planner returned HTTP ${res.status}.`);
      return parsePlannerResponse(await res.json(), req);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error('Planner did not answer within 20 s.');
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(t);
    }
  }
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
  return mode === 'remote' && url ? new HttpPlannerClient(url, 20_000, apiKey) : new MockPlannerClient();
}

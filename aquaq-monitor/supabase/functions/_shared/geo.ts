import type { LatLon, Polygon } from './types.ts';

const EARTH_R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

/** Initial bearing from a to b, degrees clockwise from north (0–360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a[0]);
  const φ2 = toRad(b[0]);
  const Δλ = toRad(b[1] - a[1]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Move `meters` from `p` along `headingDeg` (flat-earth approximation, fine at lake scale). */
export function moveM(p: LatLon, headingDeg: number, meters: number): LatLon {
  const h = toRad(headingDeg);
  const dNorth = Math.cos(h) * meters;
  const dEast = Math.sin(h) * meters;
  return [p[0] + toDeg(dNorth / EARTH_R), p[1] + toDeg(dEast / (EARTH_R * Math.cos(toRad(p[0]))))];
}

/** Convert local east/north metre offsets around an origin into lat/lon. */
export function fromLocal(origin: LatLon, xEastM: number, yNorthM: number): LatLon {
  return [
    origin[0] + toDeg(yNorthM / EARTH_R),
    origin[1] + toDeg(xEastM / (EARTH_R * Math.cos(toRad(origin[0])))),
  ];
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(p: LatLon, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    const intersect = yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Shortest distance (m) from a point to the polygon's edge. */
export function distanceToEdgeM(p: LatLon, poly: Polygon): number {
  let best = Infinity;
  const kx = EARTH_R * Math.cos(toRad(p[0])) * (Math.PI / 180);
  const ky = EARTH_R * (Math.PI / 180);
  const local = (q: LatLon) => [(q[1] - p[1]) * kx, (q[0] - p[0]) * ky] as const;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = local(poly[j]);
    const [bx, by] = local(poly[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    best = Math.min(best, Math.hypot(cx, cy));
  }
  return best;
}

export function polygonCentroid(poly: Polygon): LatLon {
  let lat = 0;
  let lon = 0;
  for (const [a, b] of poly) {
    lat += a;
    lon += b;
  }
  return [lat / poly.length, lon / poly.length];
}

export function pathLengthM(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceM(points[i - 1], points[i]);
  return total;
}

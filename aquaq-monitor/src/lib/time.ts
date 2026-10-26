export const TIME_ZONE = 'Asia/Kolkata';

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, day: '2-digit', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

export const fmtDateTime = (v: string | number | Date) => `${dateTimeFmt.format(toDate(v))} IST`;
export const fmtDate = (v: string | number | Date) => dateFmt.format(toDate(v));
export const fmtShortDate = (v: string | number | Date) => shortDateFmt.format(toDate(v));
export const fmtTime = (v: string | number | Date) => timeFmt.format(toDate(v));

export function fmtAgo(seconds: number): string {
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'due now';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d} d ${h} h` : `${h} h ${m} min`;
}

export const DAY_MS = 86_400_000;

import { NavLink, Outlet } from 'react-router-dom';
import { BarChart3, Bell, Cpu, Gauge, LogOut, Map, Route as RouteIcon, Settings } from 'lucide-react';
import { useData, useSnapshot, isAdmin } from '@/data/DataProvider';
import { LoadingState } from '@/components/ChartCard';
import { AlertNotifier } from '@/features/alerts/AlertNotifier';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  short?: string;
  icon: typeof Gauge;
  end?: boolean;
  /** Shown in the phone bottom bar; the rest go in the phone header. */
  primary?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', short: 'Home', icon: Gauge, end: true, primary: true },
  { to: '/map', label: 'Live map', short: 'Map', icon: Map, primary: true },
  { to: '/alerts', label: 'Alerts', icon: Bell, primary: true },
  { to: '/missions', label: 'Missions', icon: RouteIcon },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, primary: true },
  { to: '/sensors', label: 'Sensors', icon: Cpu, primary: true },
];

export function AppShell() {
  const { user, signOut, source } = useData();
  const snap = useSnapshot();
  const items = isAdmin(user) ? [...NAV, { to: '/settings', label: 'Settings', icon: Settings }] : NAV;
  const unresolved = snap.alerts.filter((a) => a.status !== 'resolved');
  const openCritical = unresolved.some((a) => a.severity === 'critical' && a.status === 'open');

  const badge = (n: NavItem, className?: string) =>
    n.to === '/alerts' && unresolved.length > 0 ? (
      <span
        className={cn(
          'min-w-[1.25rem] rounded-full px-1.5 text-center text-[11px] font-semibold leading-5',
          openCritical ? 'bg-red-600 text-white' : 'bg-secondary text-secondary-foreground',
          className,
        )}
      >
        {unresolved.length}
        <span className="sr-only"> unresolved alerts{openCritical ? ', including open critical' : ''}</span>
      </span>
    ) : null;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-[2000] focus:m-2 focus:rounded focus:bg-card focus:p-2">
        Skip to content
      </a>
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-card md:flex short:w-14">
        <Brand />
        <nav aria-label="Main" className="flex-1 space-y-1 px-2">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn('relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent short:px-2 short:py-1.5', isActive && 'bg-accent text-accent-foreground')
              }
              title={n.label}
            >
              <n.icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1 short:sr-only">{n.label}</span>
              {badge(n, 'short:absolute short:-right-1 short:-top-1')}
            </NavLink>
          ))}
        </nav>
        <div className="border-t p-3 text-sm short:p-2">
          <div className="font-medium short:hidden">{user?.full_name}</div>
          <div className="text-xs text-muted-foreground short:hidden">
            <span className="capitalize">{user?.role}</span> · {user?.email}
          </div>
          <button onClick={() => void signOut()} className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <LogOut className="h-3.5 w-3.5" aria-hidden /> <span className="short:sr-only">Sign out</span>
          </button>
        </div>
      </aside>

      <header className="flex items-center justify-between border-b bg-card px-4 py-2 md:hidden">
        <Brand compact />
        <nav aria-label="More" className="flex items-center gap-1">
          {items
            .filter((n) => !n.primary)
            .map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => cn('rounded p-2', isActive ? 'text-primary' : 'text-muted-foreground')} aria-label={n.label} title={n.label}>
                <n.icon className="h-5 w-5" aria-hidden />
              </NavLink>
            ))}
          <button onClick={() => void signOut()} className="rounded p-2 text-muted-foreground" aria-label="Sign out" title="Sign out">
            <LogOut className="h-5 w-5" aria-hidden />
          </button>
        </nav>
      </header>

      <main id="main" className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-16 md:pb-0">
        {source.kind === 'demo' && (
          <div className="border-b bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100 short:hidden">
            Demo mode: simulated boat and stations on a seeded demo lake. No real hardware is connected.
          </div>
        )}
        {snap.ready ? <Outlet /> : <LoadingState text="Loading water body…" />}
      </main>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-[1100] flex border-t bg-card md:hidden">
        {items
          .filter((n) => n.primary)
          .map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn('relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-primary' : 'text-muted-foreground')
              }
            >
              <n.icon className="h-5 w-5" aria-hidden />
              {n.short ?? n.label}
              {badge(n, 'absolute right-[calc(50%-1.6rem)] top-0.5')}
            </NavLink>
          ))}
      </nav>
      {snap.ready && <AlertNotifier />}
    </div>
  );
}

function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2', compact ? '' : 'px-4 py-4 short:px-3 short:py-2')}>
      <img src="/icon.svg" alt="" className="h-7 w-7" />
      <div className="leading-tight short:sr-only">
        <div className="font-semibold">AquaQ Monitor</div>
        {!compact && <div className="text-xs text-muted-foreground">Water quality &amp; boat ops</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-4 pb-2 pt-4 md:px-6">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useData } from '@/data/DataProvider';
import type { Role } from '@shared/types.ts';
import { LoadingState } from '@/components/ChartCard';
import { AppShell } from '@/features/layout/AppShell';
import { LoginPage } from '@/features/auth/LoginPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { LiveMapPage } from '@/features/map/LiveMapPage';
import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { ZoneDetailPage } from '@/features/zones/ZoneDetailPage';
import { SensorsPage } from '@/features/sensors/SensorsPage';
import { MissionsPage } from '@/features/missions/MissionsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';

function RequireAuth({ children, roles }: { children: ReactNode; roles?: Role[] }) {
  const { user, authChecked } = useData();
  const loc = useLocation();
  if (!authChecked) return <LoadingState text="Checking session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="p-6 text-sm">
        <h1 className="text-lg font-semibold">Not available for your role</h1>
        <p className="text-muted-foreground">This page needs the {roles.join(' or ')} role. You are signed in as {user.role}.</p>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="map" element={<LiveMapPage />} />
        <Route path="missions" element={<MissionsPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="zones/:zoneId" element={<ZoneDetailPage />} />
        <Route path="sensors" element={<SensorsPage />} />
        <Route
          path="settings"
          element={
            <RequireAuth roles={['admin']}>
              <SettingsPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Profile } from '@shared/types.ts';
import { DemoSource } from './demoSource';
import { SupabaseSource } from './supabaseSource';
import type { DataSource, Snapshot } from './source';

function createSource(): DataSource {
  const kind = import.meta.env.VITE_DATA_SOURCE ?? 'demo';
  if (kind === 'supabase') {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('VITE_DATA_SOURCE=supabase needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
    return new SupabaseSource(url, key);
  }
  return new DemoSource();
}

interface Ctx {
  source: DataSource;
  user: Profile | null;
  authChecked: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const DataCtx = createContext<Ctx | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const source = useMemo(createSource, []);
  const [user, setUser] = useState<Profile | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    source
      .getSession()
      .then(async (p) => {
        if (cancelled) return;
        setUser(p);
        if (p) await source.init();
      })
      .finally(() => !cancelled && setAuthChecked(true));
    return () => {
      cancelled = true;
    };
  }, [source]);

  const value = useMemo<Ctx>(
    () => ({
      source,
      user,
      authChecked,
      signIn: async (email, password) => {
        const p = await source.signIn(email, password);
        await source.init();
        setUser(p);
      },
      signOut: async () => {
        await source.signOut();
        setUser(null);
      },
    }),
    [source, user, authChecked],
  );

  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}

export function useData(): Ctx {
  const ctx = useContext(DataCtx);
  if (!ctx) throw new Error('useData outside DataProvider');
  return ctx;
}

export function useSnapshot(): Snapshot {
  const { source } = useData();
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}

export function useUser(): Profile {
  const { user } = useData();
  if (!user) throw new Error('useUser on an unauthenticated route');
  return user;
}

export const canOperate = (u: Profile | null) => u?.role === 'operator' || u?.role === 'admin';
export const isAdmin = (u: Profile | null) => u?.role === 'admin';

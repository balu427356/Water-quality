import { useEffect, useState } from 'react';
import type { Reading } from '@shared/types.ts';
import { useData } from './DataProvider';
import type { ReadingQuery } from './source';

/** Run a readings query and re-run it whenever the query (by value) changes. */
export function useReadings(q: ReadingQuery | null): { data: Reading[]; loading: boolean; error: string | null } {
  const { source } = useData();
  const key = JSON.stringify(q);
  const [state, setState] = useState<{ data: Reading[]; loading: boolean; error: string | null }>({ data: [], loading: q != null, error: null });

  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    source
      .queryReadings(q)
      .then((data) => !cancelled && setState({ data, loading: false, error: null }))
      .catch((e: unknown) => !cancelled && setState({ data: [], loading: false, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source]);

  return state;
}

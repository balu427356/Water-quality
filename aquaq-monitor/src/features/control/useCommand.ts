import { useState } from 'react';
import type { CommandPayload, CommandType } from '@shared/types.ts';
import { useData, useSnapshot, useUser } from '@/data/DataProvider';
import type { CommandError } from '@/data/source';

/** Send a boat command, keeping the server's rejection reason for display. */
export function useCommand() {
  const { source } = useData();
  const user = useUser();
  const snap = useSnapshot();
  const [error, setError] = useState<CommandError | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(type: CommandType, payload: CommandPayload = {}) {
    setBusy(true);
    setError(null);
    try {
      return await source.issueCommand(user, type, payload);
    } catch (e) {
      setError(e as CommandError);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const pending = snap.commands.filter((c) => c.status === 'pending' || c.status === 'acknowledged');
  return { send, error, setError, busy, pending };
}

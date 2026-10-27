import { useEffect, useEffectEvent } from 'react';
import { registerSessionReset, type SessionChange } from '@/lib/session';

/**
 * Runs `onChange` when the session changes while the component is mounted:
 * signed out, another tenant or account, here or in another tab (lib/session.ts,
 * `registerSessionReset`). The query cache's reset does not reach component
 * state, nor the last result a mounted `useMutation` keeps after the mutation
 * cache is cleared: a component showing something of the previous session (a
 * secret shown once) clears it here.
 */
export function useOnSessionChange(onChange: (change: SessionChange) => void) {
  const handle = useEffectEvent(onChange);
  useEffect(() => registerSessionReset((change) => handle(change)), []);
}

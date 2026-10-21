import { WifiOffIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOnline } from '@/lib/pwa';
import { useRealtime } from '@/lib/realtime';

/** True from a socket drop until it is back; false while it never connected (connecting is not lost). */
function useSocketLost(): boolean {
  const realtime = useRealtime();
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (!realtime) {
      return;
    }
    const onLost = () => setLost(true);
    const onBack = () => setLost(false);
    realtime.socket.on('disconnect', onLost);
    realtime.socket.on('connect', onBack);
    return () => {
      realtime.socket.off('disconnect', onLost);
      realtime.socket.off('connect', onBack);
      setLost(false);
    };
  }, [realtime]);
  return lost;
}

/**
 * Offline (`navigator.onLine`), or online while the realtime socket is
 * down (the server unreachable): live updates are paused, what is on
 * screen may be stale. Gone by itself when the connection returns.
 */
export function OfflineBanner() {
  const { t } = useTranslation('pwa');
  const online = useOnline();
  const socketLost = useSocketLost();
  if (online && !socketLost) {
    return null;
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 bg-muted px-4 py-2 text-sm"
    >
      <WifiOffIcon className="size-4 shrink-0" />
      <span>{t(online ? 'reconnecting' : 'offline')}</span>
    </div>
  );
}

import { useState } from 'react';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { buildStatus, fetchVersion, loadedSha } from '@/lib/build-version';

const short = (sha?: string) => sha?.slice(0, 12) ?? 'Unknown';

/** Explicit checks only; never poll or query GitHub for deployment state. */
export function BuildInfo() {
  const [versions, setVersions] = useState<{ web?: string; api?: string; checked: boolean }>({ checked: false });
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      const [web, api] = await Promise.all([
        fetchVersion('/version.json').catch(() => undefined),
        fetchVersion('/health/version').catch(() => undefined),
      ]);
      setVersions({ web, api, checked: true });
    } finally {
      setBusy(false);
    }
  };
  const status = buildStatus(loadedSha, versions.web);
  return (
    <div className="space-y-1 px-2 py-2 text-xs text-muted-foreground" aria-label="Build information">
      <div className="font-medium text-foreground">Build information</div>
      <div title={loadedSha || 'Unknown'}>This tab: {short(loadedSha || undefined)}</div>
      <div title={versions.web || 'Unknown'}>Deployed web: {short(versions.web)}</div>
      <div title={versions.api || 'Unknown'}>API: {short(versions.api)}</div>
      <div role="status">{!versions.checked ? 'Not checked' : status === 'current' ? 'Up to date with deployed web' : status === 'stale' ? 'Update available' : 'Version unknown'}</div>
      <div className="flex gap-2 pt-1">
        <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void refresh()}>{busy ? 'Checking…' : 'Check version'}</Button>
        {status === 'stale' && <Button type="button" size="xs" onClick={() => window.location.reload()}>Reload</Button>}
      </div>
    </div>
  );
}

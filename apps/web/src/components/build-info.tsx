import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@nestjs-monorepo-template/ui/components/dropdown-menu';
import { buildStatus, fetchVersion, loadedSha } from '@/lib/build-version';
import { reloadForBuildUpdate } from '@/lib/sw-update';

const short = (sha: string | undefined, unknown: string) =>
  sha?.slice(0, 12) ?? unknown;

/** On-demand: no polling or network calls until the user asks. */
export function BuildInfo() {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<{
    web?: string;
    api?: string;
    checked: boolean;
  }>({ checked: false });
  const [busy, setBusy] = useState(false);
  const statusId = useId();

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
  const unknown = t('build.unknown');
  const copyDetails = () => {
    const details = [
      `${t('build.tab')}: ${loadedSha || unknown}`,
      `${t('build.web')}: ${versions.web || unknown}`,
      `${t('build.api')}: ${versions.api || unknown}`,
    ].join('\n');
    void globalThis.navigator.clipboard?.writeText(details);
  };

  return (
    // A group named by its label, not a div with an aria-label: a menu may
    // only own items and groups (axe "aria-required-children"). It lives in
    // the user menu (the only place this is rendered).
    <DropdownMenuGroup className="space-y-1 px-2 py-2 text-xs text-muted-foreground">
      <DropdownMenuLabel className="p-0 font-medium text-foreground">
        {t('build.title')}
      </DropdownMenuLabel>
      <div title={loadedSha || unknown}>
        {t('build.tab')}: {short(loadedSha, unknown)}
      </div>
      <div title={versions.web || unknown}>
        {t('build.web')}: {short(versions.web, unknown)}
      </div>
      <div title={versions.api || unknown}>
        {t('build.api')}: {short(versions.api, unknown)}
      </div>
      <div id={statusId}>
        {!versions.checked
          ? t('build.notChecked')
          : status === 'current'
            ? t('build.current')
            : status === 'stale'
              ? t('build.stale')
              : t('build.unknownStatus')}
      </div>
      {/* Menu items (kept open): a menu may not own plain buttons. */}
      {/* The status is read with the item that changes it (no live region: a menu may not own one). */}
      <DropdownMenuItem
        aria-describedby={statusId}
        closeOnClick={false}
        disabled={busy}
        onClick={() => void refresh()}
      >
        {busy ? t('build.checking') : t('build.check')}
      </DropdownMenuItem>
      {status === 'stale' && (
        <DropdownMenuItem onClick={reloadForBuildUpdate}>
          {t('build.reload')}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        disabled={!globalThis.navigator.clipboard}
        onClick={copyDetails}
      >
        {t('build.copy')}
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

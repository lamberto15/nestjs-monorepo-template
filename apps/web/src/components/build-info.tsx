import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
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
    <div
      className="space-y-1 px-2 py-2 text-xs text-muted-foreground"
      aria-label={t('build.title')}
    >
      <div className="font-medium text-foreground">{t('build.title')}</div>
      <div title={loadedSha || unknown}>
        {t('build.tab')}: {short(loadedSha, unknown)}
      </div>
      <div title={versions.web || unknown}>
        {t('build.web')}: {short(versions.web, unknown)}
      </div>
      <div title={versions.api || unknown}>
        {t('build.api')}: {short(versions.api, unknown)}
      </div>
      <div role="status">
        {!versions.checked
          ? t('build.notChecked')
          : status === 'current'
            ? t('build.current')
            : status === 'stale'
              ? t('build.stale')
              : t('build.unknownStatus')}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? t('build.checking') : t('build.check')}
        </Button>
        {status === 'stale' && (
          <Button type="button" size="xs" onClick={reloadForBuildUpdate}>
            {t('build.reload')}
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={copyDetails}
          disabled={!globalThis.navigator.clipboard}
        >
          {t('build.copy')}
        </Button>
      </div>
    </div>
  );
}

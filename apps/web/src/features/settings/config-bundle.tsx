import {
  unwrap,
  type GetResponse,
  type operations,
} from '@nestjs-monorepo-template/api-client';
import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Label } from '@nestjs-monorepo-template/ui/components/label';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { FormAlert } from '@/lib/form';

type Bundle = GetResponse<'/v1/config-bundles/export'>;
type Preview =
  operations['ConfigBundlesController_preview_v1']['responses'][200]['content']['application/json'];

/**
 * Promoting configuration (docs/settings.md): download this tenant's
 * settings and custom roles as a bundle, or load one exported elsewhere,
 * see what it would change (a dry run, nothing written), then apply it.
 */
export function ConfigBundleCard() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const fileId = useId();
  const [bundle, setBundle] = useState<Bundle>();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    try {
      const exported = await unwrap(api.GET('/v1/config-bundles/export'));
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'config-bundle.json';
      link.click();
      URL.revokeObjectURL(url);
    } catch (failure) {
      toast.error(errorMessage(failure));
    }
  };

  const load = async (file: File | undefined) => {
    setPreview(undefined);
    setError(undefined);
    setBundle(undefined);
    if (!file) return;
    let parsed: Bundle;
    try {
      parsed = JSON.parse(await file.text()) as Bundle;
    } catch {
      setError(t('bundle.notJson'));
      return;
    }
    setBusy(true);
    try {
      setPreview(
        await unwrap(
          api.POST('/v1/config-bundles/preview', { body: { bundle: parsed } }),
        ),
      );
      setBundle(parsed);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!bundle || !preview) return;
    setBusy(true);
    try {
      const applied = await unwrap(
        api.POST('/v1/config-bundles/apply', {
          body: { bundle, targetVersion: preview.targetVersion },
        }),
      );
      toast.success(t('bundle.applied', applied));
      setBundle(undefined);
      setPreview(undefined);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const changes = preview?.changes.filter(
    (change) => change.action !== 'unchanged',
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('bundle.title')}</CardTitle>
        <CardDescription>{t('bundle.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <Button variant="outline" onClick={() => void download()}>
            {t('bundle.export')}
          </Button>
          <div className="flex flex-col gap-2">
            <Label htmlFor={fileId}>{t('bundle.load')}</Label>
            <Input
              id={fileId}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(event) => void load(event.target.files?.[0])}
            />
          </div>
        </div>
        {error && <FormAlert message={error} />}
        {preview && (
          <div className="flex flex-col gap-3">
            {[...preview.errors, ...preview.warnings].length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {preview.errors.map((issue, index) => (
                  <li key={`e${index}`} className="text-destructive">
                    {issue.ref && (
                      <span className="font-mono">{issue.ref}: </span>
                    )}
                    {issue.message}
                  </li>
                ))}
                {preview.warnings.map((issue, index) => (
                  <li key={`w${index}`} className="text-muted-foreground">
                    {issue.ref && (
                      <span className="font-mono">{issue.ref}: </span>
                    )}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {changes?.length ? (
              <ul className="flex flex-col gap-1 text-sm">
                {changes.map((change) => (
                  <li
                    key={`${change.type}:${change.ref}`}
                    className="flex gap-2"
                  >
                    <Badge variant="outline">
                      {t(`bundle.actions.${change.action}`)}
                    </Badge>
                    <span>{t(`bundle.types.${change.type}`)}</span>
                    <span className="font-mono">{change.ref}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('bundle.nothing')}
              </p>
            )}
            <div>
              <Button
                disabled={busy || !preview.valid || !changes?.length}
                onClick={() => void apply()}
              >
                {t('bundle.apply')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

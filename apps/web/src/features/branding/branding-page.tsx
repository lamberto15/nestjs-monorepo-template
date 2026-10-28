import { unwrap } from '@nestjs-monorepo-template/api-client';
import {
  Alert,
  AlertDescription,
} from '@nestjs-monorepo-template/ui/components/alert';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadTrigger,
} from '@nestjs-monorepo-template/ui/components/file-upload';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LockIcon, Trash2Icon, UploadIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Page, PageHeader } from '@/components/page-header';
import { RecordState } from '@/components/records/record-state';
import { HexPicker } from '@/features/tags/tag-dialog';
import { api } from '@/lib/api';
import { brandingQuery, type Branding } from '@/lib/branding';
import { errorMessage } from '@/lib/errors';
import { useStaleDraftSession } from '@/lib/form';
import { postMultipart } from '@/lib/upload';

/** What the API takes of a logo (BrandingService): the browser checks the same, the API decides by the bytes. */
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const LOGO_MAX_BYTES = 512 * 1024;
/** The picker's starting point when the tenant has no colour yet. */
const START_COLOR = '#2563eb';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The tenant's colour, sender name and logo (docs/branding.md), for who manages settings. */
export function BrandingPage() {
  const { t } = useTranslation('branding');
  // The page says a failed read (below): no toast, no retries, as `useBranding`.
  const query = useQuery({
    ...brandingQuery,
    retry: false,
    meta: { errorToast: false },
  });
  return (
    <Page width="narrow">
      <PageHeader title={t('title')} description={t('description')} />
      <RecordState
        query={query}
        notFound={{ title: t('error.title'), description: t('error.generic') }}
        error={{
          title: t('error.title'),
          generic: t('error.generic'),
          retry: t('error.retry'),
        }}
      >
        {(data) => (
          <>
            {data.locked && (
              <Alert>
                <LockIcon />
                <AlertDescription>{t('locked')}</AlertDescription>
              </Alert>
            )}
            {/* Remounted by what is stored: the form starts from it. */}
            <ValuesForm
              key={`${data.primaryColor}|${data.mailFromName}`}
              branding={data}
            />
            <LogoSection branding={data} version={query.dataUpdatedAt} />
          </>
        )}
      </RecordState>
    </Page>
  );
}

function useBrandingMutation<T>(
  mutationFn: (input: T) => Promise<Branding | void>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: brandingQuery.queryKey }),
  });
}

function ValuesForm(props: { branding: Branding }) {
  const { t } = useTranslation('branding');
  const { branding } = props;
  const editable = branding.canEdit;
  const [color, setColor] = useState(branding.primaryColor ?? '');
  const [name, setName] = useState(branding.mailFromName ?? '');
  const staleDraftSession = useStaleDraftSession();
  const save = useBrandingMutation(
    (body: { primaryColor: string | null; mailFromName: string | null }) =>
      unwrap(api.PUT('/v1/branding', { body })),
  );
  const trimmed = name.trim();
  const changed =
    color.toLowerCase() !== (branding.primaryColor ?? '').toLowerCase() ||
    trimmed !== (branding.mailFromName ?? '');
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (staleDraftSession()) return;
        save.mutate(
          { primaryColor: color || null, mailFromName: trimmed || null },
          { onSuccess: () => toast.success(t('saved')) },
        );
      }}
    >
      <Field>
        <FieldLabel>{t('color.label')}</FieldLabel>
        <FieldDescription>{t('color.hint')}</FieldDescription>
        {color ? (
          <div className="flex flex-col gap-2">
            <fieldset disabled={!editable} className="contents">
              <HexPicker value={color} onChange={setColor} />
            </fieldset>
            {editable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setColor('')}
              >
                <XIcon />
                {t('color.remove')}
              </Button>
            )}
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={!editable}
            onClick={() => setColor(START_COLOR)}
          >
            {t('color.set')}
          </Button>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor="mail-from-name">{t('mailName.label')}</FieldLabel>
        <FieldDescription>{t('mailName.hint')}</FieldDescription>
        <Input
          id="mail-from-name"
          value={name}
          maxLength={60}
          disabled={!editable}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {editable && (
        <Button
          type="submit"
          className="self-start"
          disabled={
            !changed || save.isPending || (color !== '' && !HEX.test(color))
          }
        >
          {t('save')}
        </Button>
      )}
    </form>
  );
}

function LogoSection(props: { branding: Branding; version: number }) {
  const { t, i18n } = useTranslation('branding');
  const queryClient = useQueryClient();
  const { branding } = props;
  const [files, setFiles] = useState<File[]>([]);
  const remove = useBrandingMutation(async () => {
    await unwrap(api.DELETE('/v1/branding/logo'));
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: brandingQuery.queryKey });
  return (
    <Field>
      <FieldLabel>{t('logo.label')}</FieldLabel>
      <FieldDescription>{t('logo.hint')}</FieldDescription>
      {branding.logoUrl && (
        <div className="flex items-center gap-4">
          {/* Same origin: the public route redirects to the image. A new upload changes the bytes, not the path: the query string (the time it was read) busts the cache. */}
          <img
            src={`${branding.logoUrl}?v=${props.version}`}
            alt={t('logo.alt')}
            className="max-h-16 max-w-48 rounded border bg-muted p-2"
          />
          {branding.canEdit && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () => toast.success(t('logo.removed')),
                })
              }
            >
              <Trash2Icon />
              {t('logo.remove')}
            </Button>
          )}
        </div>
      )}
      {branding.canEdit && (
        <FileUpload
          label={t('logo.label')}
          value={files}
          onValueChange={setFiles}
          maxFiles={1}
          maxSize={LOGO_MAX_BYTES}
          accept={LOGO_TYPES.join(',')}
          onFileReject={(file, message) =>
            toast.error(
              t('logo.rejected', {
                name: file.name,
                reason:
                  message === 'File too large'
                    ? t('logo.tooLarge', {
                        max: new Intl.NumberFormat(i18n.language).format(
                          LOGO_MAX_BYTES / 1024,
                        ),
                      })
                    : t('logo.typeRefused'),
              }),
            )
          }
          onUpload={async (batch, { onSuccess, onError, onProgress }) => {
            const file = batch[0];
            if (!file) return;
            try {
              const form = new FormData();
              form.append('file', file);
              await postMultipart<Branding>(
                '/v1/branding/logo',
                form,
                (percent) => onProgress(file, percent),
              );
              onSuccess(file);
              setFiles([]);
              await refresh();
              toast.success(t('logo.saved'));
            } catch (error) {
              toast.error(errorMessage(error));
              onError(file, error instanceof Error ? error : new Error());
            }
          }}
        >
          <FileUploadDropzone>
            <div className="flex flex-col items-center gap-1 text-center">
              <UploadIcon className="size-6 text-muted-foreground" />
              <p className="text-sm font-medium">{t('logo.drop')}</p>
              <p className="text-xs text-muted-foreground">{t('logo.limit')}</p>
            </div>
            <FileUploadTrigger
              render={<Button variant="outline" size="sm" type="button" />}
            >
              {t('logo.choose')}
            </FileUploadTrigger>
          </FileUploadDropzone>
        </FileUpload>
      )}
    </Field>
  );
}

import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  errorsByPath,
  publicLinksQuery,
  useCreatePublicLink,
  useRevokePublicLink,
} from './api';

/**
 * A form's public links (docs/forms.md, "Public forms"): an editor makes
 * one explicitly (until a day, at most so many submissions), copies its URL
 * the one time it is shown, sees how much each took, and revokes it.
 */
export function PublicLinks(props: { formId: string }) {
  const { t, i18n } = useTranslation('forms');
  const links = useQuery(publicLinksQuery(props.formId));
  const create = useCreatePublicLink(props.formId);
  const revoke = useRevokePublicLink(props.formId);
  const [until, setUntil] = useState('');
  const [most, setMost] = useState('');
  const errors = errorsByPath(create.error);
  const date = (value: string) =>
    new Date(value).toLocaleDateString(i18n.language);
  // When the panel opened: a link's state is as of then (and after a change, refetched).
  const [now] = useState(() => Date.now());

  return (
    <section
      aria-label={t('public.links')}
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2 className="text-sm font-medium">{t('public.links')}</h2>
      <p className="text-sm text-muted-foreground">{t('public.hint')}</p>
      <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Field>
          <FieldLabel htmlFor={`${props.formId}-until`}>
            {t('public.until')}
          </FieldLabel>
          <Input
            id={`${props.formId}-until`}
            type="date"
            value={until}
            onChange={(event) => setUntil(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${props.formId}-most`}>
            {t('public.most')}
          </FieldLabel>
          <Input
            id={`${props.formId}-most`}
            type="number"
            min={1}
            value={most}
            onChange={(event) => setMost(event.target.value)}
          />
        </Field>
        <Button
          variant="outline"
          disabled={create.isPending}
          onClick={() =>
            create.mutate({
              // The end of that day, where the editor is.
              ...(until && {
                expiresAt: new Date(`${until}T23:59:59`).toISOString(),
              }),
              ...(most && { maxSubmissions: Number(most) }),
            })
          }
        >
          {t('public.create')}
        </Button>
      </div>
      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errors.expiresAt ??
            errors.maxSubmissions ??
            (create.error as { message?: string }).message}
        </p>
      )}
      {create.data && (
        <Field>
          <FieldLabel htmlFor={`${props.formId}-url`}>
            {t('public.url')}
          </FieldLabel>
          <Input id={`${props.formId}-url`} readOnly value={create.data.url} />
          <FieldDescription>{t('public.once')}</FieldDescription>
        </Field>
      )}
      {(links.data?.items.length ?? 0) > 0 && (
        <ul aria-label={t('public.links')} className="flex flex-col gap-2">
          {links.data!.items.map((link) => {
            const working =
              link.revokedAt === null &&
              new Date(link.expiresAt).getTime() > now &&
              link.submissions < link.maxSubmissions;
            return (
              <li
                key={link.id}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <Badge variant={working ? 'secondary' : 'outline'}>
                  {working ? t('public.working') : t('public.closed')}
                </Badge>
                <span>
                  {t('public.summary', {
                    until: date(link.expiresAt),
                    submissions: link.submissions,
                    most: link.maxSubmissions,
                  })}
                </span>
                {link.revokedAt === null && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(link.id)}
                  >
                    {t('public.revoke')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

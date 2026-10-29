import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@nestjs-monorepo-template/ui/components/dialog';
import {
  Field,
  FieldError,
  FieldLabel,
} from '@nestjs-monorepo-template/ui/components/field';
import { Input } from '@nestjs-monorepo-template/ui/components/input';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useCan } from '@/lib/features';
import {
  errorsByPath,
  formsEnabledQuery,
  formsQuery,
  useCreateForm,
} from './api';

/**
 * The tenant's forms (docs/forms.md): each with its status and published
 * version; editors build and publish them, people with `Form.submit` fill
 * the published ones in, `Form.readResponses` reads the answers.
 */
export function FormsPage() {
  const { t } = useTranslation('forms');
  const enabled = useQuery(formsEnabledQuery);
  const forms = useQuery({ ...formsQuery, enabled: enabled.data === true });
  const mayEdit = useCan('Form.edit');
  const maySubmit = useCan('Form.submit');
  const mayRead = useCan('Form.readResponses');
  const [creating, setCreating] = useState(false);

  if (enabled.data === false) {
    return (
      <Page>
        <PageHeader title={t('title')} />
        <EmptyState title={t('off.title')} description={t('off.description')} />
      </Page>
    );
  }
  return (
    <Page>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          mayEdit && (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon />
              {t('new')}
            </Button>
          )
        }
      />
      {forms.isPending ? (
        <Skeleton className="h-40 w-full" aria-busy />
      ) : forms.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      ) : forms.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table aria-label={t('title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('name')}</TableHead>
                <TableHead>{t('status')}</TableHead>
                <TableHead>{t('version')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.data.items.map((form) => (
                <TableRow key={form.id}>
                  <TableCell className="font-medium">
                    {mayEdit ? (
                      <Link
                        to="/forms/$formId"
                        params={{ formId: form.id }}
                        className="hover:underline"
                      >
                        {form.name}
                      </Link>
                    ) : (
                      form.name
                    )}
                    <div className="text-xs text-muted-foreground">
                      {form.slug}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        form.status === 'active' ? 'secondary' : 'outline'
                      }
                    >
                      {t(`statuses.${form.status}`)}
                    </Badge>
                    {form.hasDraftChanges && (
                      <Badge variant="outline" className="ms-2">
                        {t('draftChanges')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {form.publishedVersion === null
                      ? t('unpublished')
                      : t('versionN', { version: form.publishedVersion })}
                  </TableCell>
                  <TableCell className="text-end">
                    <div className="flex justify-end gap-2">
                      {maySubmit &&
                        form.publishedVersion !== null &&
                        form.status === 'active' && (
                          <Button
                            variant="outline"
                            size="sm"
                            render={
                              <Link
                                to="/forms/$formId/fill"
                                params={{ formId: form.id }}
                              />
                            }
                          >
                            {t('fill')}
                          </Button>
                        )}
                      {(mayRead || maySubmit) &&
                        form.publishedVersion !== null && (
                          <Button
                            variant="ghost"
                            size="sm"
                            render={
                              <Link
                                to="/forms/$formId/submissions"
                                params={{ formId: form.id }}
                              />
                            }
                          >
                            {t('submissions')}
                          </Button>
                        )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <CreateFormDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}

/** A new form: its name and slug; its fields are built on its page. */
function CreateFormDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('forms');
  const navigate = useNavigate();
  const create = useCreateForm();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const errors = errorsByPath(create.error);
  const taken =
    (create.error as { code?: string } | null)?.code === 'form_slug_taken';

  const slugOf = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      // One dash at most at either end: the line above collapsed each run.
      .replace(/^-|-$/g, '')
      .slice(0, 80);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (!open) {
          create.reset();
          setName('');
          setSlug('');
          setSlugTouched(false);
        }
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              { name: name.trim(), slug },
              {
                onSuccess: (form) => {
                  props.onOpenChange(false);
                  void navigate({
                    to: '/forms/$formId',
                    params: { formId: form.id },
                  });
                },
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('new')}</DialogTitle>
          </DialogHeader>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="form-name">{t('name')}</FieldLabel>
            <Input
              id="form-name"
              value={name}
              maxLength={200}
              required
              onChange={(event) => {
                setName(event.target.value);
                if (!slugTouched) setSlug(slugOf(event.target.value));
              }}
            />
            {errors.name && <FieldError errors={[{ message: errors.name }]} />}
          </Field>
          <Field data-invalid={!!errors.slug || taken}>
            <FieldLabel htmlFor="form-slug">{t('slug')}</FieldLabel>
            <Input
              id="form-slug"
              value={slug}
              maxLength={80}
              required
              aria-invalid={!!errors.slug || taken}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
            />
            {(errors.slug || taken) && (
              <FieldError
                errors={[{ message: taken ? t('slugTaken') : errors.slug }]}
              />
            )}
          </Field>
          <DialogFooter>
            <Button
              type="submit"
              disabled={create.isPending || !name.trim() || !slug}
            >
              {t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

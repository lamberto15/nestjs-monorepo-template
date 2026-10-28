import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Skeleton } from '@nestjs-monorepo-template/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nestjs-monorepo-template/ui/components/table';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useCan } from '@/lib/features';
import {
  errorsByPath,
  formQuery,
  publishedQuery,
  submissionsQuery,
  useSubmit,
} from './api';
import {
  type AnswerDrafts,
  answersOf,
  FormRenderer,
  initialDrafts,
} from './form-renderer';

/**
 * A published form to fill in: the version the server publishes now, its
 * answers checked in the browser first (required, numbers) and on the
 * server against that version. Another version published meanwhile is a
 * 409 `form_version_outdated`: the page loads it again.
 */
export function FillPage(props: { formId: string }) {
  const { t } = useTranslation('forms');
  const client = useQueryClient();
  const published = useQuery(publishedQuery(props.formId));
  const submit = useSubmit(props.formId);
  const [drafts, setDrafts] = useState<AnswerDrafts>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  if (published.isPending)
    return <Skeleton className="h-64 w-full" aria-busy />;
  if (published.isError) {
    return (
      <Page width="narrow">
        <PageHeader title={t('fillTitle')} />
        <EmptyState title={t('notPublished')} />
      </Page>
    );
  }
  const form = published.data;
  const values = drafts ?? initialDrafts(form.definition);
  const outdated =
    (submit.error as { code?: string } | null)?.code ===
    'form_version_outdated';

  if (sent) {
    return (
      <Page width="narrow">
        <PageHeader title={form.name} />
        <p role="status">{t('sent')}</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setDrafts(undefined);
              setSent(false);
            }}
          >
            {t('again')}
          </Button>
          <Button variant="ghost" render={<Link to="/forms" />}>
            {t('back')}
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      <PageHeader
        title={form.name}
        description={form.description ?? undefined}
      />
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          const { answers, errors: local } = answersOf(
            form.definition,
            values,
            {
              required: t('required'),
              number: t('notANumber'),
            },
          );
          setErrors(local);
          if (Object.keys(local).length > 0) return;
          submit.mutate(
            { versionId: form.versionId, answers },
            {
              onSuccess: () => setSent(true),
              onError: (error) => {
                setErrors(errorsByPath(error));
                if (
                  (error as { code?: string }).code === 'form_version_outdated'
                ) {
                  void client.invalidateQueries(publishedQuery(props.formId));
                }
              },
            },
          );
        }}
      >
        <FormRenderer
          definition={form.definition}
          value={values}
          onChange={(key, value) => setDrafts({ ...values, [key]: value })}
          errors={errors}
        />
        {outdated && (
          <p role="alert" className="text-sm text-destructive">
            {t('outdated')}
          </p>
        )}
        <div>
          <Button type="submit" disabled={submit.isPending}>
            {t('send')}
          </Button>
        </div>
      </form>
    </Page>
  );
}

/**
 * A form's submissions: everyone's to `Form.readResponses`, one's own
 * otherwise (the server decides), each with its version and answers.
 */
export function SubmissionsPage(props: { formId: string }) {
  const { t, i18n } = useTranslation('forms');
  const form = useQuery(formQuery(props.formId));
  const submissions = useQuery(submissionsQuery(props.formId));
  const everyone = useCan('Form.readResponses');

  return (
    <Page>
      <PageHeader
        title={form.data?.name ?? t('submissions')}
        description={everyone ? t('allSubmissions') : t('mySubmissions')}
        actions={
          <Button variant="outline" render={<Link to="/forms" />}>
            {t('back')}
          </Button>
        }
      />
      {submissions.isPending ? (
        <Skeleton className="h-40 w-full" aria-busy />
      ) : submissions.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      ) : submissions.data.items.length === 0 ? (
        <EmptyState title={t('noSubmissions')} />
      ) : (
        <div className="overflow-hidden rounded-md border">
          <Table aria-label={t('submissions')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('submittedAt')}</TableHead>
                <TableHead>{t('version')}</TableHead>
                <TableHead>{t('answers')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.data.items.map((submission) => (
                <TableRow key={submission.id}>
                  <TableCell>
                    {new Date(submission.createdAt).toLocaleString(
                      i18n.language,
                    )}
                  </TableCell>
                  <TableCell>
                    {t('versionN', { version: submission.version })}
                  </TableCell>
                  <TableCell>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                      {Object.entries(submission.answers).map(
                        ([key, value]) => (
                          <div key={key} className="contents">
                            <dt className="text-muted-foreground">{key}</dt>
                            <dd className="break-words">
                              {Array.isArray(value)
                                ? value.join(', ')
                                : String(value)}
                            </dd>
                          </div>
                        ),
                      )}
                    </dl>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Page>
  );
}

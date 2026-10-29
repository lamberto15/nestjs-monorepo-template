import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Progress } from '@nestjs-monorepo-template/ui/components/progress';
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
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { useCan } from '@/lib/features';
import { focusFirstInvalidIn } from '@/lib/form-focus';
import {
  errorsByPath,
  formQuery,
  type FormSection,
  publishedQuery,
  submissionsQuery,
  useSubmit,
} from './api';
import {
  type AnswerDrafts,
  answersOf,
  FormRenderer,
  initialDrafts,
  pagesOf,
  stateOf,
} from './form-renderer';

/** Whether an error's path (`answers.<key>…`) is one of these fields'. */
const onPage = (path: string, keys: ReadonlySet<string>) =>
  keys.has(path.split('.')[1] ?? '');

/** The keys of a page's fields. */
const keysOf = (page: readonly FormSection[]) =>
  new Set(page.flatMap((section) => section.fields.map((field) => field.key)));

/**
 * A published form to fill in: the version the server publishes now, its
 * answers checked in the browser first (required, numbers, a group's
 * items) and on the server against that version. Another version
 * published meanwhile is a 409 `form_version_outdated`: the page loads it
 * again. A form with pages is a wizard: one page at a time, a page its
 * conditions hide all of skipped, Next checks the page's answers before
 * moving on, Back keeps them; the server's errors open the first page that
 * has one. The focus goes to the first invalid input, or to a new page's
 * heading.
 */
export function FillPage(props: { formId: string }) {
  const { t } = useTranslation('forms');
  const client = useQueryClient();
  const published = useQuery(publishedQuery(props.formId));
  const submit = useSubmit(props.formId);
  const [drafts, setDrafts] = useState<AnswerDrafts>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);
  const [page, setPage] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

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
  const pages = pagesOf(form.definition.sections);
  const { visible } = stateOf(form.definition, values);
  // The pages with a field to show, in order: a wizard's steps.
  const steps = pages.flatMap((sections, index) =>
    sections.some((section) =>
      section.fields.some((field) => visible.has(field.key)),
    )
      ? [index]
      : [],
  );
  const current = steps.includes(page) ? page : (steps[0] ?? 0);
  const step = steps.indexOf(current);
  const last = step >= steps.length - 1;
  const wizard = pages.length > 1;

  const show = (next: Record<string, string>) => {
    setErrors(next);
    if (Object.keys(next).length > 0) {
      requestAnimationFrame(() => focusFirstInvalidIn(formRef.current));
    }
  };
  const go = (index: number) => {
    setPage(index);
    setErrors({});
    requestAnimationFrame(() => headingRef.current?.focus());
  };
  /** The first step with one of these errors, if any. */
  const stepWith = (found: Record<string, string>) =>
    steps.find((index) => {
      const keys = keysOf(pages[index]!);
      return Object.keys(found).some((path) => onPage(path, keys));
    });

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
              setPage(0);
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
        ref={formRef}
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
              minItems: (count) => t('group.minItems', { count }),
              maxItems: (count) => t('group.maxItems', { count }),
            },
          );
          if (!last) {
            // Next: this page's answers only; the later ones aren't in yet.
            const keys = keysOf(pages[current]!);
            const here = Object.fromEntries(
              Object.entries(local).filter(([path]) => onPage(path, keys)),
            );
            if (Object.keys(here).length > 0) show(here);
            else go(steps[step + 1]!);
            return;
          }
          if (Object.keys(local).length > 0) {
            const at = stepWith(local);
            if (at !== undefined && at !== current) setPage(at);
            show(local);
            return;
          }
          submit.mutate(
            { versionId: form.versionId, answers },
            {
              onSuccess: () => setSent(true),
              onError: (error) => {
                const found = errorsByPath(error);
                const at = stepWith(found);
                if (at !== undefined && at !== current) setPage(at);
                show(found);
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
        {wizard && (
          <Progress
            value={((step + 1) / Math.max(steps.length, 1)) * 100}
            aria-label={t('wizard.progress')}
            className="flex-col"
          >
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-medium outline-none"
            >
              {t('wizard.step', { n: step + 1, total: steps.length })}
            </h2>
          </Progress>
        )}
        <FormRenderer
          definition={form.definition}
          value={values}
          onChange={(key, value) => setDrafts({ ...values, [key]: value })}
          errors={errors}
          page={wizard ? current : undefined}
        />
        {outdated && (
          <p role="alert" className="text-sm text-destructive">
            {t('outdated')}
          </p>
        )}
        <div className="flex gap-2">
          {wizard && step > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => go(steps[step - 1]!)}
            >
              {t('wizard.previous')}
            </Button>
          )}
          <Button type="submit" disabled={submit.isPending}>
            {last ? t('send') : t('wizard.next')}
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

import { Badge } from '@nestjs-monorepo-template/ui/components/badge';
import {
  Timeline,
  TimelineConnector,
  TimelineContent,
  TimelineDescription,
  TimelineDot,
  TimelineHeader,
  TimelineItem,
  TimelineTime,
  TimelineTitle,
} from '@nestjs-monorepo-template/ui/components/timeline';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DetailItem, DetailList } from '@/components/records/detail-list';
import { RecordState } from '@/components/records/record-state';
import { useDateTimeFormat } from '@/lib/date-time';
import { ApprovalActions } from './actions';
import { approvalQuery, type Approval } from './api';
import { useActionLabel } from './inbox-page';
import { StatusBadge } from './status';

/** `/approvals/$id`: the request, its stages and approvers, and its history. */
export function DetailPage(props: { id: string }) {
  const { t } = useTranslation('approvals');
  const query = useQuery(approvalQuery(props.id));
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <Link
        to="/approvals"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon className="size-4 rtl:rotate-180" />
        {t('detail.back')}
      </Link>
      <RecordState
        query={query}
        notFound={{
          title: t('detail.notFound.title'),
          description: t('detail.notFound.description'),
        }}
        error={{
          title: t('detail.error.title'),
          generic: t('detail.error.generic'),
          retry: t('detail.error.retry'),
        }}
      >
        {({ approval, etag }) => (
          <ApprovalView approval={approval} etag={etag} />
        )}
      </RecordState>
    </section>
  );
}

function ApprovalView(props: { approval: Approval; etag?: string }) {
  const { t } = useTranslation('approvals');
  const date = useDateTimeFormat();
  const actionLabel = useActionLabel();
  const { approval } = props;
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-medium break-words">{approval.title}</h1>
          <p className="text-sm text-muted-foreground">
            {actionLabel(approval)}
          </p>
        </div>
        <ApprovalActions approval={approval} etag={props.etag} />
      </header>
      <DetailList>
        <DetailItem
          label={t('detail.status')}
          value={<StatusBadge status={approval.status} />}
        />
        <DetailItem
          label={t('detail.record')}
          value={
            approval.link ? (
              <Link to={approval.link} className="hover:underline">
                {approval.title}
              </Link>
            ) : (
              approval.title
            )
          }
        />
        <DetailItem
          label={t('detail.requester')}
          value={approval.requesterName}
        />
        <DetailItem
          label={t('detail.requestedAt')}
          value={date(approval.createdAt)}
        />
        <DetailItem label={t('detail.comment')} value={approval.comment} />
        <DetailItem label={t('detail.dueAt')} value={date(approval.dueAt)} />
        <DetailItem
          label={t('detail.outcome')}
          value={
            approval.outcomeReason
              ? t(`outcome.${approval.outcomeReason}`, {
                  defaultValue: approval.outcomeReason,
                })
              : undefined
          }
        />
      </DetailList>
      <Stages approval={approval} />
      <History approval={approval} />
    </>
  );
}

function Stages({ approval }: { approval: Approval }) {
  const { t } = useTranslation('approvals');
  const date = useDateTimeFormat();
  return (
    <section aria-labelledby="approval-stages" className="flex flex-col gap-2">
      <h2 id="approval-stages" className="font-medium">
        {t('stages.title')}
      </h2>
      <ol className="flex flex-col gap-3">
        {approval.stages.map((stage) => {
          // Assignments of every round are kept; a stage shows the current one.
          const assignments = approval.assignments.filter(
            (entry) =>
              entry.stage === stage.index && entry.round === approval.round,
          );
          return (
            <li key={stage.index} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {t('stages.name', {
                    current: stage.index + 1,
                    count: approval.stageCount,
                    name: stage.name,
                  })}
                </span>
                <Badge variant="outline">
                  {t(`stages.state.${stage.state}`)}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t(`stages.mode.${String(stage.mode.type)}`, {
                    defaultValue: String(stage.mode.type),
                    n: typeof stage.mode.n === 'number' ? stage.mode.n : 0,
                  })}
                </span>
              </div>
              {assignments.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('stages.noApprovers')}
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {assignments.map((entry) => (
                    <li key={entry.id}>
                      <span className="font-medium">{entry.approverName}</span>{' '}
                      <span className="text-muted-foreground">
                        {t(`stages.assignment.${entry.status}`)}
                        {entry.decidedAt && ` · ${date(entry.decidedAt)}`}
                        {entry.decidedByName &&
                          entry.decidedBy !== entry.approverId &&
                          ` · ${t('stages.by', { name: entry.decidedByName })}`}
                        {entry.escalated && ` · ${t('stages.escalated')}`}
                      </span>
                      {entry.comment && (
                        <p className="text-muted-foreground">
                          “{entry.comment}”
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function History({ approval }: { approval: Approval }) {
  const { t } = useTranslation('approvals');
  const date = useDateTimeFormat();
  const events = approval.timeline;
  return (
    <section aria-labelledby="approval-history" className="flex flex-col gap-2">
      <h2 id="approval-history" className="font-medium">
        {t('history.title')}
      </h2>
      <Timeline activeIndex={events.length - 1}>
        {events.map((event) => {
          const comment = event.details?.comment;
          return (
            <TimelineItem key={event.id}>
              <TimelineDot />
              <TimelineConnector />
              <TimelineContent>
                <TimelineHeader>
                  <TimelineTitle>
                    {t(`history.type.${event.type}`, {
                      defaultValue: event.type,
                    })}
                  </TimelineTitle>
                  <TimelineTime dateTime={event.createdAt}>
                    {date(event.createdAt)}
                  </TimelineTime>
                </TimelineHeader>
                <TimelineDescription>
                  {[
                    event.actorName,
                    event.stage !== null
                      ? t('history.stage', { stage: event.stage + 1 })
                      : null,
                    typeof comment === 'string' ? `“${comment}”` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </TimelineDescription>
              </TimelineContent>
            </TimelineItem>
          );
        })}
      </Timeline>
    </section>
  );
}

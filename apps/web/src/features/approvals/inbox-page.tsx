import {
  Tabs,
  TabsList,
  TabsTrigger,
} from '@nestjs-monorepo-template/ui/components/tabs';
import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDateTimeFormat } from '@/lib/date-time';
import { useFeature, useMe } from '@/lib/features';
import { inboxQuery, tabs, type ApprovalItem, type Tab } from './api';
import { DecisionDialog, type DecisionTarget } from './decision-dialog';
import { DelegationsDialog } from './delegations-dialog';
import { pollInterval } from './use-approval-count';
import { StatusBadge } from './status';

/** `/approvals`: what waits for the user, what they asked for, and what ended. */
export function InboxPage(props: { tab: Tab }) {
  const { t } = useTranslation('approvals');
  const navigate = useNavigate();
  const realtime = useFeature('realtime');
  // Deciding is refused while acting as someone else (403 approval_impersonation).
  const canDecide = !useMe()?.user.impersonator && props.tab === 'mine';
  const list = useInfiniteQuery(
    inboxQuery(props.tab, realtime ? false : pollInterval),
  );
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  const [delegating, setDelegating] = useState(false);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-medium">{t('inbox.title')}</h1>
        <Button variant="outline" onClick={() => setDelegating(true)}>
          {t('delegations.open')}
        </Button>
      </div>
      <Tabs
        value={props.tab}
        onValueChange={(value) =>
          void navigate({
            to: '/approvals',
            search: { tab: value as Tab },
          })
        }
      >
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`tabs.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('inbox.error')}
        </p>
      ) : items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {t(`empty.${props.tab}`)}
        </p>
      ) : (
        <ul className="rounded-lg border" aria-label={t(`tabs.${props.tab}`)}>
          {items.map((item) => (
            <ApprovalRow
              key={item.id}
              item={item}
              canDecide={canDecide}
              onDecide={(decision) =>
                setTarget({ id: item.id, title: item.title, decision })
              }
            />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage && <Spinner />}
          {t('inbox.loadMore')}
        </Button>
      )}
      <DecisionDialog target={target} onClose={() => setTarget(null)} />
      <DelegationsDialog open={delegating} onOpenChange={setDelegating} />
    </div>
  );
}

/** What was asked, by name: `approvals:actions.Note.publish`, else the key. */
export function useActionLabel() {
  const { t } = useTranslation('approvals');
  return (item: Pick<ApprovalItem, 'key'>) =>
    t(`actions.${item.key}`, { defaultValue: item.key });
}

function ApprovalRow(props: {
  item: ApprovalItem;
  canDecide: boolean;
  onDecide: (decision: 'approve' | 'reject') => void;
}) {
  const { t } = useTranslation('approvals');
  const date = useDateTimeFormat();
  const actionLabel = useActionLabel();
  const { item } = props;
  return (
    <li className="flex flex-wrap items-center gap-3 border-b p-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* `link` is the record's page in the web app, set by its handler. */}
          {item.link ? (
            <Link to={item.link} className="font-medium hover:underline">
              {item.title}
            </Link>
          ) : (
            <span className="font-medium">{item.title}</span>
          )}
          <StatusBadge status={item.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {actionLabel(item)} ·{' '}
          {t('row.stage', {
            name: item.stageName,
            current: item.currentStage + 1,
            count: item.stageCount,
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('row.requested', {
            name: item.requesterName,
            date: date(item.createdAt),
          })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {props.canDecide && (
          <>
            <Button size="sm" onClick={() => props.onDecide('approve')}>
              {t('decision.approve.button')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => props.onDecide('reject')}
            >
              {t('decision.reject.button')}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          nativeButton={false}
          render={<Link to="/approvals/$id" params={{ id: item.id }} />}
        >
          {t('row.details')}
        </Button>
      </div>
    </li>
  );
}

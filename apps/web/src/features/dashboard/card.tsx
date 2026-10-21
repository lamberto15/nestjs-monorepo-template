import { Button } from '@nestjs-monorepo-template/ui/components/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@nestjs-monorepo-template/ui/components/card';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { RelativeTime } from '@/features/notifications/relative-time';

/** A card's frame: title, a link to the whole list, then its body. */
export function DashboardCardFrame(props: {
  title: string;
  description?: string;
  /** A `<Link to="…" />`: the "View all" button renders it. */
  viewAll?: ReactElement;
  children: ReactNode;
}) {
  const { t } = useTranslation('dashboard');
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {props.title}
        </CardTitle>
        {props.description && (
          <CardDescription>{props.description}</CardDescription>
        )}
        {props.viewAll && (
          <CardAction>
            <Button
              size="sm"
              variant="ghost"
              nativeButton={false}
              render={props.viewAll}
            >
              {t('viewAll')}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>{props.children}</CardContent>
    </Card>
  );
}

/** A list card: rows, a spinner while loading, or one line when there are none. */
export function DashboardListCard(props: {
  title: string;
  description?: string;
  viewAll?: ReactElement;
  pending: boolean;
  empty: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  return (
    <DashboardCardFrame
      title={props.title}
      description={props.description}
      viewAll={props.viewAll}
    >
      {props.pending ? (
        <Spinner />
      ) : props.isEmpty ? (
        <p className="text-sm text-muted-foreground">{props.empty}</p>
      ) : (
        <ul className="flex flex-col divide-y">{props.children}</ul>
      )}
    </DashboardCardFrame>
  );
}

/** One row: a title, a second line, and how long ago. */
export function DashboardRow(props: {
  primary: ReactNode;
  secondary?: ReactNode;
  at?: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{props.primary}</span>
        {props.secondary && (
          <span className="truncate text-xs text-muted-foreground">
            {props.secondary}
          </span>
        )}
      </span>
      {props.at && (
        <span className="shrink-0 text-xs text-muted-foreground">
          <RelativeTime value={props.at} />
        </span>
      )}
    </li>
  );
}

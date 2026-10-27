import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { unwrap } from '@nestjs-monorepo-template/api-client';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeOffIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { visible, useFeatures, useMe } from '@/lib/features';
import { settingsQuery } from '@/features/settings/settings';
import { api } from '@/lib/api';
import { DashboardCardFrame } from './card';
import { dashboard, type DashboardCard } from './registry';

const DASHBOARD_LAYOUT_KEY = 'dashboard.layout';

type DashboardLayout = { hidden: string[]; order: string[] };

function readLayout(
  value: unknown,
  cards: readonly DashboardCard[],
): DashboardLayout {
  const ids = new Set(cards.map((card) => card.id));
  const input =
    value && typeof value === 'object'
      ? (value as { hidden?: unknown; order?: unknown })
      : {};
  const unique = (items: unknown) =>
    Array.isArray(items)
      ? [
          ...new Set(
            items.filter(
              (id): id is string => typeof id === 'string' && ids.has(id),
            ),
          ),
        ]
      : [];
  return { hidden: unique(input.hidden), order: unique(input.order) };
}

function arranged(cards: readonly DashboardCard[], layout: DashboardLayout) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const preferred = layout.order.flatMap((id) => {
    const card = byId.get(id);
    if (!card) return [];
    byId.delete(id);
    return [card];
  });
  return [...preferred, ...cards.filter((card) => byId.has(card.id))];
}

function QuickActions() {
  const { t } = useTranslation('dashboard');
  // The labels are `common` keys unless they name a namespace, like the menu's.
  const { t: translate } = useTranslation();
  const features = useFeatures();
  const me = useMe();
  const actions = visible(dashboard.actions, features, me?.can);
  if (actions.length === 0) {
    return null;
  }
  return (
    <DashboardCardFrame title={t('quick.title')}>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.to}
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to={action.to} />}
          >
            <action.icon aria-hidden />
            {translate(action.label)}
          </Button>
        ))}
      </div>
    </DashboardCardFrame>
  );
}

/**
 * The home page: what waits for the user, what happened, what changed. The
 * cards come from the features (`features/<feature>/dashboard.ts`); each
 * shows only with its switch on and its permission held (hiding is for the
 * user; the API refuses either way), and asks only for its own data.
 */
export function Dashboard() {
  const { t } = useTranslation('dashboard');
  const features = useFeatures();
  const me = useMe();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(settingsQuery);
  const available = visible(dashboard.cards, features, me?.can);
  const stored = settings?.find(
    (setting) => setting.key === DASHBOARD_LAYOUT_KEY,
  )?.value;
  const layout = readLayout(stored, available);
  const cards = arranged(available, layout).filter(
    (card) => !layout.hidden.includes(card.id),
  );
  const save = useMutation({
    mutationFn: (value: DashboardLayout) =>
      unwrap(
        api.PUT('/v1/settings/{key}/mine', {
          params: { path: { key: DASHBOARD_LAYOUT_KEY } },
          body: { value },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
  });
  const reset = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE('/v1/settings/{key}/mine', {
          params: { path: { key: DASHBOARD_LAYOUT_KEY } },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey }),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        {available.length > 0 && (
          <DashboardCustomizer
            cards={arranged(available, layout)}
            layout={layout}
            pending={save.isPending || reset.isPending}
            onChange={(value) => save.mutate(value)}
            onReset={() => reset.mutate()}
          />
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {cards.map((card) => (
          <div
            key={card.id}
            className={card.wide ? 'lg:col-span-2' : undefined}
          >
            <Suspense fallback={<Spinner />}>
              <card.component />
            </Suspense>
          </div>
        ))}
        <QuickActions />
      </div>
    </div>
  );
}

function DashboardCustomizer(props: {
  cards: DashboardCard[];
  layout: DashboardLayout;
  pending: boolean;
  onChange: (layout: DashboardLayout) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const { t: translate } = useTranslation();
  const [open, setOpen] = useState(false);
  const move = (id: string, delta: -1 | 1) => {
    const order = props.cards.map((card) => card.id);
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    props.onChange({ ...props.layout, order });
  };
  const toggle = (id: string) => {
    const hidden = props.layout.hidden.includes(id)
      ? props.layout.hidden.filter((value) => value !== id)
      : [...props.layout.hidden, id];
    props.onChange({ ...props.layout, hidden });
  };
  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <SlidersHorizontalIcon />
        {t('customize.button')}
      </Button>
      {open && (
        <div
          className="absolute end-0 z-20 mt-2 w-80 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
          aria-label={t('customize.title')}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('customize.title')}</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.pending}
              onClick={props.onReset}
            >
              <RotateCcwIcon />
              {t('customize.reset')}
            </Button>
          </div>
          <ul className="flex flex-col gap-1">
            {props.cards.map((card, index) => {
              const hidden = props.layout.hidden.includes(card.id);
              return (
                <li
                  key={card.id}
                  className="flex items-center gap-1 rounded border p-1"
                >
                  <span className="min-w-0 flex-1 truncate px-1 text-sm">
                    {translate(card.label)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('customize.up', {
                      name: translate(card.label),
                    })}
                    disabled={props.pending || index === 0}
                    onClick={() => move(card.id, -1)}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('customize.down', {
                      name: translate(card.label),
                    })}
                    disabled={props.pending || index === props.cards.length - 1}
                    onClick={() => move(card.id, 1)}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(
                      hidden ? 'customize.show' : 'customize.hide',
                      {
                        name: translate(card.label),
                      },
                    )}
                    disabled={props.pending}
                    onClick={() => toggle(card.id)}
                  >
                    {hidden ? <EyeIcon /> : <EyeOffIcon />}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

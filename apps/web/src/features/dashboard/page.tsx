import { Button } from '@nestjs-monorepo-template/ui/components/button';
import { Spinner } from '@nestjs-monorepo-template/ui/components/spinner';
import { Link } from '@tanstack/react-router';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { visible, useFeatures, useMe } from '@/lib/features';
import { DashboardCardFrame } from './card';
import { dashboard } from './registry';

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
  const cards = visible(dashboard.cards, features, me?.can);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-medium">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
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

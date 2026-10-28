import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2Icon, CircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DashboardCardFrame } from '@/features/dashboard/card';
import { useFeatures, useMe, visible } from '@/lib/features';
import { setupSteps } from './steps';

/**
 * The organization setup checklist (docs/setup-checklist.md): the setup
 * screens this administrator may open, each ticked from what the tenant
 * actually has. Only permitted, enabled steps show; a person with none sees
 * no card.
 */
export function SetupCard() {
  const { t } = useTranslation('setup');
  const features = useFeatures();
  const me = useMe();
  const steps = visible(setupSteps, features, me?.can);
  const results = useQueries({
    queries: steps.map((step) => ({
      queryKey: ['setup', step.id],
      queryFn: step.done,
      // A hint on the home page: a failure is not worth a toast.
      meta: { errorToast: false },
    })),
  });
  if (steps.length === 0) return null;
  const done = results.filter((result) => result.data === true).length;
  return (
    <DashboardCardFrame
      title={t('title')}
      description={t('progress', { done, total: steps.length })}
    >
      <ul className="flex flex-col divide-y">
        {steps.map((step, index) => {
          const complete = results[index]?.data === true;
          return (
            <li
              key={step.id}
              className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0"
            >
              {complete ? (
                <CheckCircle2Icon
                  className="size-4 shrink-0 text-primary"
                  aria-label={t('done')}
                />
              ) : (
                <CircleIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-label={t('todo')}
                />
              )}
              <Link
                to={step.to}
                className={
                  complete
                    ? 'text-muted-foreground'
                    : 'font-medium hover:underline'
                }
              >
                {t(`steps.${step.id}`)}
              </Link>
            </li>
          );
        })}
      </ul>
    </DashboardCardFrame>
  );
}

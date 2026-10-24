import type { LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { dashboard } from '@/features/dashboard/registry';
import { nav, visibleGroups } from '@/nav';
import { visible, useFeatures, useMe } from '@/lib/features';

export type QuickCommand = {
  to: string;
  label: string;
  icon: LucideIcon;
  kind: 'page' | 'action';
};

/** The pages and feature actions this user may use as commands (`>` in the palette). */
export function useQuickCommands(): QuickCommand[] {
  const { t } = useTranslation();
  const features = useFeatures();
  const me = useMe();
  const can = me?.can;
  return useMemo(() => {
    const pages = visibleGroups(nav, features, can).flatMap((group) =>
      group.items.map((item) => ({
        to: item.to,
        label: t(item.label),
        icon: item.icon,
        kind: 'page' as const,
      })),
    );
    const pagePaths = new Set(pages.map((command) => command.to));
    const actions = visible(dashboard.actions, features, can)
      .filter((action) => !pagePaths.has(action.to))
      .map((action) => ({
        to: action.to,
        label: t(action.label),
        icon: action.icon,
        kind: 'action' as const,
      }));
    return [...pages, ...actions];
  }, [features, can, t]);
}

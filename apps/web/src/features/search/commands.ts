import type { LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { dashboard } from '@/features/dashboard/registry';
import { nav, visibleGroups } from '@/nav';
import { visible, useFeatures, useMe } from '@/lib/features';

export type QuickCommandKind = 'page' | 'action';

export type QuickCommand = {
  to: string;
  label: string;
  icon: LucideIcon;
  kind: QuickCommandKind;
};

const command = (
  item: { to: string; label: string; icon: LucideIcon },
  kind: QuickCommandKind,
  translate: (key: string) => string,
): QuickCommand => ({
  to: item.to,
  label: translate(item.label),
  icon: item.icon,
  kind,
});

/** The pages and feature actions this user may use as commands (`>` in the palette). */
export function useQuickCommands(): QuickCommand[] {
  const { t } = useTranslation();
  const features = useFeatures();
  const me = useMe();
  const can = me?.can;
  return useMemo(() => {
    const pages = visibleGroups(nav, features, can).flatMap((group) =>
      group.items.map((item) => command(item, 'page', t)),
    );
    const pagePaths = new Set(pages.map(({ to }) => to));
    const actions = visible(dashboard.actions, features, can)
      .filter(({ to }) => !pagePaths.has(to))
      .map((action) => command(action, 'action', t));
    return [...pages, ...actions];
  }, [features, can, t]);
}

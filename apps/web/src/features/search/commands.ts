import type { LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { nav, visibleGroups } from '@/nav';
import { useFeatures, useMe } from '@/lib/features';

export type QuickCommand = { to: string; label: string; icon: LucideIcon };

/** The nav entries this user sees, as "go to" commands (`>` in the palette). */
export function useQuickCommands(): QuickCommand[] {
  const { t } = useTranslation();
  const features = useFeatures();
  const me = useMe();
  const can = me?.can;
  return useMemo(
    () =>
      visibleGroups(nav, features, can).flatMap((group) =>
        group.items.map((item) => ({
          to: item.to,
          label: t(item.label),
          icon: item.icon,
        })),
      ),
    [features, can, t],
  );
}

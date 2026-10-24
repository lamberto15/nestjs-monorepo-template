import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Gated } from '@/lib/features';
import type { FileRoutesByTo } from '@/routeTree.gen';

/** A card of the home page: shown with its switch on and its permission held. */
export type DashboardCard = Gated & {
  id: string;
  /** An i18n key used by dashboard personalization controls. */
  label: string;
  /** Lower first; ties by id. */
  order: number;
  /** Spans both columns (a chart). */
  wide?: boolean;
  /** Lazy, so a card's code (a chart) loads only where the card shows. */
  component: ComponentType;
};

/** A button of the quick-actions card. */
export type DashboardAction = Gated & {
  to: Extract<keyof FileRoutesByTo, string>;
  /** An i18n key: `common` unless it names a namespace (`ns:key`). */
  label: string;
  icon: LucideIcon;
  order: number;
};

/** What a feature's `features/<feature>/dashboard.ts` exports (default). */
export type DashboardContribution = {
  cards?: DashboardCard[];
  actions?: DashboardAction[];
};

/** Merges contributions into the sorted cards and actions. */
export function mergeDashboard(
  contributions: readonly DashboardContribution[],
) {
  return {
    cards: contributions
      .flatMap((c) => c.cards ?? [])
      .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    actions: contributions
      .flatMap((c) => c.actions ?? [])
      .toSorted((a, b) => a.order - b.order || a.to.localeCompare(b.to)),
  };
}

// Each feature adds its cards in its own file, so none edits this one, and
// taking a feature out (`pnpm feature:remove`) takes its cards with it.
const contributed = Object.values(
  import.meta.glob<DashboardContribution | DashboardContribution[]>(
    '../*/dashboard.ts',
    { eager: true, import: 'default' },
  ),
).flat();

export const dashboard = mergeDashboard(contributed);

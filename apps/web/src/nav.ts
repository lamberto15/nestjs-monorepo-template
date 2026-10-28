import type { LucideIcon } from 'lucide-react';
import { LayoutDashboardIcon } from 'lucide-react';
import type { FeatureName, Permission } from '@/lib/features';
import { visible } from '@/lib/features';
import type { Features } from '@/lib/session';
import type { FileRoutesByTo } from '@/routeTree.gen';

export type NavItem = {
  to: Extract<keyof FileRoutesByTo, string>;
  /** An i18n key: `common` unless it names a namespace (`ns:key`). */
  label: string;
  icon: LucideIcon;
  /** Shown only when this switch is on (`GET /v1/features`). */
  feature?: FeatureName;
  /**
   * Shown only with this permission, `Subject.action` (`me.can`), or with
   * any of a list.
   */
  permission?: Permission | readonly Permission[];
  /**
   * Shown only to the deployment's operators, and with `TENANCY=multi`
   * (`useOperator()`: the API says who is one by answering their routes).
   */
  operator?: true;
  /**
   * Shown only to users acting in the operator tenant (`me.tenant.operator`),
   * in either tenancy: the operations API answers them alone (403
   * `operator_required`), a single-tenant deployment's one tenant included.
   */
  operatorTenant?: true;
  /**
   * A hook returning a count shown next to the label (undefined or 0: none).
   * A hook, so the entry's feature owns its query; the menu calls it in a
   * component of its own per entry, so the hook's identity must be stable.
   */
  badge?: () => number | undefined;
};

/**
 * The sidebar's sections, in this order: `home` (the pages everyone checks,
 * no heading), then one per kind of work.
 */
export const groupIds = [
  'home',
  'workspace',
  'people',
  'security',
  'developers',
  'configuration',
  'platform',
] as const;
export type NavGroupId = (typeof groupIds)[number];

export type NavGroup = {
  id: NavGroupId;
  /** An i18n key (`nav` namespace, `src/locales/<lng>/nav.json`). */
  label: string;
  items: NavItem[];
};

/**
 * What a feature's `features/<feature>/nav.ts` exports (default): its entry,
 * the group it sits in, and `order` within it (lower first; ties by path).
 */
export type NavContribution = NavItem & { group: NavGroupId; order: number };

/** Merges contributions into the groups, each sorted by `order`. */
export function mergeNav(
  contributions: readonly NavContribution[],
): NavGroup[] {
  return groupIds.map((id) => ({
    id,
    label: `nav:groups.${id}`,
    items: contributions
      .filter((c) => c.group === id)
      .toSorted((a, b) => a.order - b.order || a.to.localeCompare(b.to))
      .map(({ group: _group, order: _order, ...item }) => item),
  }));
}

/** The groups this user sees: gated items only, empty groups dropped. */
export function visibleGroups(
  groups: readonly NavGroup[],
  features: Features | undefined,
  can: Record<string, boolean> | undefined,
  operator = false,
  operatorTenant = false,
): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: visible(group.items, features, can).filter(
        (item) =>
          (!item.operator || operator) &&
          (!item.operatorTenant || operatorTenant),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/** Whether `pathname` is the entry's page or a page under it. */
const under = (to: string, pathname: string) =>
  to === '/'
    ? pathname === '/'
    : pathname === to || pathname.startsWith(`${to}/`);

/**
 * The entry of the page at `pathname`, with its group: the longest match, so
 * `/api-clients/usage` is API usage, not API clients. None off the menu.
 */
export function activeEntry(
  groups: readonly NavGroup[],
  pathname: string,
): { group: NavGroup; item: NavItem } | undefined {
  let found: { group: NavGroup; item: NavItem } | undefined;
  for (const group of groups) {
    for (const item of group.items) {
      if (
        under(item.to, pathname) &&
        item.to.length > (found?.item.to.length ?? -1)
      ) {
        found = { group, item };
      }
    }
  }
  return found;
}

// Each feature adds its entry in its own file, so none edits this one.
const contributed = Object.values(
  import.meta.glob<NavContribution | NavContribution[]>('./features/*/nav.ts', {
    eager: true,
    import: 'default',
  }),
).flat();

export const nav: NavGroup[] = mergeNav([
  {
    group: 'home',
    order: 0,
    to: '/',
    label: 'nav.dashboard',
    icon: LayoutDashboardIcon,
  },
  ...contributed,
]);

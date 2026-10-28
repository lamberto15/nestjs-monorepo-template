import { LayoutDashboardIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { allFeatures } from '@/test/server';
import { mergeNav, nav, visibleGroups, type NavContribution } from '@/nav';

const icon = LayoutDashboardIcon;
const entry = (
  group: NavContribution['group'],
  order: number,
  extra: Partial<NavContribution> = {},
): NavContribution => ({
  group,
  order,
  to: '/',
  label: `${group}${order}`,
  icon,
  ...extra,
});

describe('mergeNav', () => {
  it('puts each contribution in its group, sorted by order', () => {
    const groups = mergeNav([
      entry('platform', 1),
      entry('workspace', 20),
      entry('workspace', 10),
    ]);
    expect(groups.map((g) => g.id)).toEqual([
      'home',
      'workspace',
      'people',
      'security',
      'developers',
      'configuration',
      'platform',
    ]);
    const items = (id: string) =>
      groups.find((g) => g.id === id)?.items.map((i) => i.label);
    expect(items('workspace')).toEqual(['workspace10', 'workspace20']);
    expect(items('people')).toEqual([]);
    expect(items('platform')).toEqual(['platform1']);
    expect(groups[1]?.items[0]).not.toHaveProperty('group');
  });

  it('collects the feature nav files into the app menu', () => {
    const tos = (id: string) =>
      nav.find((g) => g.id === id)?.items.map((i) => i.to) ?? [];
    // The platform's entries, in order; a feature's own (its nav.ts, gone
    // with `pnpm feature:remove`) sits among them by its `order`.
    expect(tos('home')).toEqual([
      '/',
      '/notifications',
      '/approvals',
      '/transfers',
    ]);
    expect(tos('workspace')).toContain('/reports');
  });
});

describe('visibleGroups', () => {
  const groups = mergeNav([
    entry('workspace', 0),
    entry('developers', 0, { permission: 'Webhook.manage' }),
    entry('platform', 0, { feature: 'impersonation' }),
  ]);
  const ids = (can: Record<string, boolean>, on: boolean) =>
    visibleGroups(groups, { ...allFeatures, impersonation: on }, can).map(
      (g) => g.id,
    );

  it('hides a group whose items are all gated off', () => {
    expect(ids({}, false)).toEqual(['workspace']);
  });

  it('gates every group by its own permission and switch', () => {
    expect(ids({ 'Webhook.manage': true }, false)).toEqual([
      'workspace',
      'developers',
    ]);
    expect(ids({}, true)).toEqual(['workspace', 'platform']);
    expect(ids({ 'Webhook.manage': true }, true)).toEqual([
      'workspace',
      'developers',
      'platform',
    ]);
  });
});

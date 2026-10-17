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
      entry('operators', 1),
      entry('workspace', 20),
      entry('workspace', 10),
    ]);
    expect(groups.map((g) => g.id)).toEqual([
      'workspace',
      'administration',
      'operators',
    ]);
    expect(groups[0]?.items.map((i) => i.label)).toEqual([
      'workspace10',
      'workspace20',
    ]);
    expect(groups[1]?.items).toEqual([]);
    expect(groups[2]?.items.map((i) => i.label)).toEqual(['operators1']);
    expect(groups[0]?.items[0]).not.toHaveProperty('group');
  });

  it('collects the feature nav files into the app menu', () => {
    const workspace = nav.find((g) => g.id === 'workspace');
    expect(workspace?.items.map((i) => i.to)).toEqual([
      '/',
      '/notifications',
      '/approvals',
      '/notes',
    ]);
  });
});

describe('visibleGroups', () => {
  const groups = mergeNav([
    entry('workspace', 0),
    entry('administration', 0, { permission: 'Webhook.manage' }),
    entry('operators', 0, { feature: 'impersonation' }),
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
      'administration',
    ]);
    expect(ids({}, true)).toEqual(['workspace', 'operators']);
    expect(ids({ 'Webhook.manage': true }, true)).toEqual([
      'workspace',
      'administration',
      'operators',
    ]);
  });
});

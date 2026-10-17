import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { LayoutDashboardIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Can, Feature, visible } from '@/lib/features';
import { featuresQuery, meQuery, type Me } from '@/lib/session';
import type { NavItem } from '@/nav';
import { allFeatures, signedInUser } from '@/test/server';

const entries: NavItem[] = [
  { to: '/', label: 'open', icon: LayoutDashboardIcon },
  {
    to: '/',
    label: 'webhooks',
    icon: LayoutDashboardIcon,
    feature: 'webhooks',
  },
  {
    to: '/',
    label: 'impersonate',
    icon: LayoutDashboardIcon,
    feature: 'impersonation',
  },
  {
    to: '/',
    label: 'notes',
    icon: LayoutDashboardIcon,
    permission: 'Note.read',
  },
  {
    to: '/',
    label: 'both',
    icon: LayoutDashboardIcon,
    feature: 'webhooks',
    permission: 'Webhook.manage',
  },
];

describe('gating the menu', () => {
  it('shows an entry only with its switch on and its permission held', () => {
    const labels = visible(entries, allFeatures, { 'Note.read': true }).map(
      (item) => item.label,
    );
    expect(labels).toEqual(['open', 'webhooks', 'notes']);
  });

  it('hides every gated entry until the switches and permissions are known', () => {
    expect(
      visible(entries, undefined, undefined).map((item) => item.label),
    ).toEqual(['open']);
  });
});

describe('<Feature> and <Can>', () => {
  it('render their children only when on / held', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(featuresQuery.queryKey, allFeatures);
    const me: Me = { ...signedInUser, can: { 'Note.read': true } };
    queryClient.setQueryData(meQuery.queryKey, me);
    render(
      <QueryClientProvider client={queryClient}>
        <Feature name="passkeys">
          <span>passkeys on</span>
        </Feature>
        <Feature name="impersonation" fallback={<span>impersonation off</span>}>
          <span>impersonation on</span>
        </Feature>
        <Can permission="Note.read">
          <span>may read</span>
        </Can>
        <Can permission="Note.delete">
          <span>may delete</span>
        </Can>
      </QueryClientProvider>,
    );
    expect(screen.getByText('passkeys on')).toBeInTheDocument();
    expect(screen.getByText('impersonation off')).toBeInTheDocument();
    expect(screen.queryByText('impersonation on')).toBeNull();
    expect(screen.getByText('may read')).toBeInTheDocument();
    expect(screen.queryByText('may delete')).toBeNull();
  });
});

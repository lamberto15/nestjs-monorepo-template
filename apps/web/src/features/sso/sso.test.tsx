import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { nav, visibleGroups } from '@/nav';
import { renderApp } from '@/test/render-app';
import { server } from '@/test/server';
import { findToast } from '@/test/toast';
import { MEMBER_ID, ROLE_ID, oauth2, oidc, useSsoApi } from './test/sso-api';

const ADMIN = ['Access.manageSso'];

describe('gating', () => {
  it('has a menu entry only with the permission', () => {
    const entries = (can: Record<string, boolean>) =>
      visibleGroups(nav, undefined, can).flatMap((g) =>
        g.items.map((i) => i.to),
      );
    expect(entries({})).not.toContain('/sso');
    expect(entries({ 'Access.manageSso': true })).toContain('/sso');
  });

  it('sends a user without the permission away, with no request', async () => {
    const { calls } = useSsoApi({ can: ['TestItem.read'] });
    const { router } = await renderApp('/sso');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.reads).toBe(0);
  });
});

describe('connections', () => {
  it('lists them with what to register at the provider', async () => {
    useSsoApi({ can: ADMIN });
    await renderApp('/sso');
    expect(await screen.findByText('Okta')).toBeVisible();
    expect(screen.getByText('Entra')).toBeVisible();
    expect(
      screen.getByText('https://app.example.com/v1/auth/sso/cb'),
    ).toBeVisible();
    expect(
      screen.getByText('https://app.example.com/v1/auth/sso/saml/acs'),
    ).toBeVisible();
  });

  it('turns a connection on and off', async () => {
    const { calls } = useSsoApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/sso');
    await screen.findByText('Okta');
    const toggles = screen.getAllByRole('switch');
    await user.click(toggles[0]!);
    await waitFor(() =>
      expect(calls.patched).toEqual([
        {
          id: '22222222-2222-4222-8222-222222222222',
          body: { enabled: true },
        },
      ]),
    );
    expect(await findToast('Okta is on.')).toBeVisible();
  });

  it('adds an OIDC connection, off until switched on', async () => {
    const { calls } = useSsoApi({ can: ADMIN, connections: [] });
    const user = userEvent.setup();
    await renderApp('/sso');
    expect(await screen.findByText(/No connections yet/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add a connection' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Give the connection a name.'),
    ).toBeVisible();
    expect(calls.created).toEqual([]);

    await user.type(within(dialog).getByLabelText('Name'), 'Okta');
    await user.type(
      within(dialog).getByLabelText('Issuer'),
      'https://acme.okta.com',
    );
    await user.type(within(dialog).getByLabelText('Client ID'), 'abc');
    await user.type(within(dialog).getByLabelText('Client secret'), 's3cret');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.created).toEqual([
        {
          protocol: 'oidc',
          name: 'Okta',
          enabled: false,
          jitProvisioning: false,
          issuer: 'https://acme.okta.com',
          clientId: 'abc',
          clientSecret: 's3cret',
        },
      ]),
    );
    expect(await screen.findByText('Okta')).toBeVisible();
  });

  it('adds a SAML connection', async () => {
    const { calls } = useSsoApi({ can: ADMIN, connections: [] });
    const user = userEvent.setup();
    await renderApp('/sso');
    await user.click(
      await screen.findByRole('button', { name: 'Add a connection' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Protocol' }),
    );
    await user.click(await screen.findByRole('option', { name: 'SAML 2.0' }));
    await user.type(within(dialog).getByLabelText('Name'), 'Entra');
    await user.type(
      within(dialog).getByLabelText('Provider entity ID'),
      'https://sts.example.com/idp',
    );
    await user.type(
      within(dialog).getByLabelText('Provider sign-on URL'),
      'https://sts.example.com/sso',
    );
    await user.type(
      within(dialog).getByLabelText('Signing certificate (PEM)'),
      'PEM1',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toMatchObject({
      protocol: 'saml',
      name: 'Entra',
      idpEntityId: 'https://sts.example.com/idp',
      idpSsoUrl: 'https://sts.example.com/sso',
      idpCertificates: ['PEM1'],
    });
  });

  it('fills a SAML connection from its metadata URL', async () => {
    const { calls } = useSsoApi({ can: ADMIN, connections: [] });
    const user = userEvent.setup();
    await renderApp('/sso');
    await user.click(
      await screen.findByRole('button', { name: 'Add a connection' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Protocol' }),
    );
    await user.click(await screen.findByRole('option', { name: 'SAML 2.0' }));
    await user.type(within(dialog).getByLabelText('Name'), 'Entra');
    const importButton = within(dialog).getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Provider metadata URL (optional)'),
      'https://meta.example.com/metadata',
    );
    await user.click(importButton);
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Provider entity ID')).toHaveValue(
        'https://meta.example.com/idp',
      ),
    );
    expect(calls.metadataImports).toEqual([
      'https://meta.example.com/metadata',
    ]);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toMatchObject({
      protocol: 'saml',
      idpEntityId: 'https://meta.example.com/idp',
      idpSsoUrl: 'https://meta.example.com/sso',
      idpCertificates: ['PEM-A', 'PEM-B'],
    });
  });

  it('edits one, keeping the secret unless a new one is typed', async () => {
    const { calls } = useSsoApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/sso');
    await screen.findByText('Okta');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Okta prod');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]!.body).toEqual({
      name: 'Okta prod',
      enabled: false,
      jitProvisioning: false,
      issuer: 'https://acme.okta.com',
      clientId: 'abc',
    });
  });

  it('fetches the metadata again, links a test sign-in and deletes after confirming', async () => {
    const { calls } = useSsoApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/sso');
    await screen.findByText('Okta');
    // Off: no test sign-in; on (Entra): a link to the login route.
    const links = screen
      .getAllByText('Test sign-in')
      .map((el) => el.closest('a'))
      .filter((a) => a !== null);
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      expect.stringContaining(
        '/v1/auth/sso/11111111-1111-4111-8111-111111111111/33333333',
      ),
    );

    await user.click(
      screen.getByRole('button', { name: 'Fetch metadata again' }),
    );
    await waitFor(() => expect(calls.refreshed).toHaveLength(1));

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
    const confirm = await screen.findByRole('alertdialog');
    expect(calls.deleted).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(calls.deleted).toEqual(['22222222-2222-4222-8222-222222222222']),
    );
  });
});

describe('domains and SCIM', () => {
  it('adds a domain, shows its record and asks to check it', async () => {
    const { calls } = useSsoApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/sso');
    await user.click(await screen.findByRole('tab', { name: 'Domains' }));
    expect(await screen.findByText('_sso-verification.acme.com')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Check the record' }));
    await waitFor(() => expect(calls.verified).toHaveLength(1));
    await user.type(screen.getByLabelText('Domain'), 'Example.org');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));
    await waitFor(() => expect(calls.domainsAdded).toEqual(['example.org']));
  });

  it('shows the SCIM endpoint and the API clients that call it', async () => {
    useSsoApi({ can: [...ADMIN, 'Access.manageClients'] });
    server.use(
      http.get('/v1/access/clients', () =>
        HttpResponse.json({
          items: [
            {
              id: '77777777-7777-4777-8777-777777777777',
              name: 'Okta SCIM',
              active: true,
              dailyQuota: null,
              createdAt: '2026-10-17T09:00:00.000Z',
              updatedAt: '2026-10-17T09:00:00.000Z',
              keys: [
                {
                  id: 'k1',
                  keyId: 'abc',
                  createdAt: '2026-10-17T09:00:00.000Z',
                  expiresAt: null,
                  revokedAt: null,
                  lastUsedAt: '2026-10-18T09:00:00.000Z',
                },
              ],
              roles: [],
              webhookEndpoints: [],
            },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/sso');
    await user.click(await screen.findByRole('tab', { name: 'SCIM' }));
    expect(
      await screen.findByText(`${window.location.origin}/v1/scim`),
    ).toBeVisible();
    expect(await screen.findByText('Okta SCIM')).toBeVisible();
    expect(screen.getByText(/last call/, { selector: 'span' })).toBeVisible();
  });

  it('says what is missing without access to API clients', async () => {
    useSsoApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/sso');
    await user.click(await screen.findByRole('tab', { name: 'SCIM' }));
    expect(
      await screen.findByText(/permission to manage API clients/),
    ).toBeVisible();
  });
});

describe('policy', () => {
  it('requires SSO and lists the exempted, who can be released', async () => {
    const { calls } = useSsoApi({
      can: ADMIN,
      policy: {
        requireSso: false,
        updatedAt: null,
        exemptions: [
          {
            userId: '77777777-7777-4777-8777-777777777777',
            email: 'root@acme.com',
            name: 'Root',
            reason: 'Break-glass',
            createdBy: null,
            createdAt: '2026-10-17T09:00:00.000Z',
          },
        ],
      },
    });
    const user = userEvent.setup();
    await renderApp('/sso');
    await user.click(await screen.findByRole('tab', { name: 'Policy' }));
    expect(await screen.findByText('Root')).toBeVisible();
    await user.click(
      screen.getByRole('switch', { name: 'Require SSO for this workspace' }),
    );
    await waitFor(() => expect(calls.policySet).toEqual([true]));
    expect(await findToast('SSO is now required.')).toBeVisible();
    await user.click(
      screen.getByRole('button', { name: 'End the exemption of Root' }),
    );
    await waitFor(() =>
      expect(calls.exemptionsEnded).toEqual([
        '77777777-7777-4777-8777-777777777777',
      ]),
    );
    expect(await screen.findByText('Nobody is exempted.')).toBeVisible();
  });
});

describe('group roles', () => {
  it('maps a group to a role and removes a mapping', async () => {
    const { calls } = useSsoApi({
      can: ADMIN,
      connections: [
        oidc({
          roleMappings: [{ group: 'old', roleId: ROLE_ID }],
          groupsAttribute: null,
        }),
      ],
    });
    const user = userEvent.setup();
    await renderApp('/sso');
    await screen.findByText('Okta');
    await user.click(screen.getByRole('button', { name: 'Group roles' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('old → Editor')).toBeVisible();
    await user.type(
      within(dialog).getByLabelText('Groups attribute or claim'),
      'roles',
    );
    await user.type(within(dialog).getByLabelText('Group'), 'staff');
    await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Editor' }));
    await user.click(
      within(dialog).getByRole('button', { name: 'Add mapping' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove old → Editor' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    expect(calls.patched[0]!.body).toEqual({
      groupsAttribute: 'roles',
      roleMappings: [{ group: 'staff', roleId: ROLE_ID }],
    });
    expect(await findToast('Saved the group roles of Okta.')).toBeVisible();
  });
});

describe('exemptions', () => {
  it('exempts a member with a reason', async () => {
    const { calls } = useSsoApi({ can: ADMIN });
    const user = userEvent.setup();
    await renderApp('/sso');
    await user.click(await screen.findByRole('tab', { name: 'Policy' }));
    await user.click(
      await screen.findByRole('button', { name: 'Exempt a member' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Member' }));
    await user.click(await screen.findByRole('option', { name: /Ann/ }));
    expect(screen.queryByRole('option', { name: /Off/ })).toBeNull();
    await user.type(within(dialog).getByLabelText('Reason'), 'IdP outage plan');
    await user.click(within(dialog).getByRole('button', { name: 'Exempt' }));
    await waitFor(() =>
      expect(calls.exemptionsAdded).toEqual([
        { userId: MEMBER_ID, reason: 'IdP outage plan' },
      ]),
    );
    expect(await findToast('Exempted Ann (ann@acme.com).')).toBeVisible();
  });
});

describe('OAuth 2.0 connections', () => {
  async function openOAuth2Dialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      await screen.findByRole('button', { name: 'Add a connection' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Protocol' }),
    );
    await user.click(
      await screen.findByRole('option', { name: 'OAuth 2.0 (custom)' }),
    );
    return dialog;
  }

  it('adds a Lark connection from the preset', async () => {
    const { calls } = useSsoApi({ can: ADMIN, connections: [] });
    const user = userEvent.setup();
    await renderApp('/sso');
    const dialog = await openOAuth2Dialog(user);
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Provider preset' }),
    );
    await user.click(await screen.findByRole('option', { name: 'Lark' }));
    // The preset filled the fields, still editable.
    expect(within(dialog).getByLabelText('Token URL')).toHaveValue(
      'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
    );
    expect(within(dialog).getByLabelText('Subject path')).toHaveValue(
      'open_id',
    );
    await user.type(within(dialog).getByLabelText('Name'), 'Lark');
    await user.type(within(dialog).getByLabelText('Client ID'), 'cli_a1b2c3');
    await user.type(within(dialog).getByLabelText('Client secret'), 's3cret');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({
      protocol: 'oauth2',
      name: 'Lark',
      enabled: false,
      jitProvisioning: false,
      preset: { name: 'lark', region: 'lark' },
      authorizationEndpoint:
        'https://accounts.larksuite.com/open-apis/authen/v1/authorize',
      tokenEndpoint:
        'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
      userinfoEndpoint:
        'https://open.larksuite.com/open-apis/authen/v1/user_info',
      clientId: 'cli_a1b2c3',
      clientSecret: 's3cret',
      tokenEndpointAuthMethod: 'client_secret_post',
      scopes: [],
      mapping: {
        root: 'data',
        subject: 'open_id',
        email: 'enterprise_email',
        name: 'name',
        picture: 'avatar_url',
        errorCode: 'code',
        emailVerified: 'verified-domains',
      },
    });
  });

  it('adds a custom connection with scopes and a verified-field email trust', async () => {
    const { calls } = useSsoApi({ can: ADMIN, connections: [] });
    const user = userEvent.setup();
    await renderApp('/sso');
    const dialog = await openOAuth2Dialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Inhouse');
    await user.type(
      within(dialog).getByLabelText('Authorization URL'),
      'https://sso.acme.com/authorize',
    );
    await user.type(
      within(dialog).getByLabelText('Token URL'),
      'https://sso.acme.com/token',
    );
    await user.type(
      within(dialog).getByLabelText('User info URL'),
      'https://sso.acme.com/me',
    );
    await user.type(within(dialog).getByLabelText('Client ID'), 'web');
    await user.type(within(dialog).getByLabelText('Client secret'), 'pw');
    await user.type(within(dialog).getByLabelText('Scopes'), 'profile{Enter}');
    await user.type(within(dialog).getByLabelText('Scopes'), 'email{Enter}');
    await user.type(within(dialog).getByLabelText('Subject path'), 'sub');
    await user.click(
      within(dialog).getByRole('combobox', { name: 'Email trust' }),
    );
    await user.click(
      await screen.findByRole('option', {
        name: 'A field says it’s verified',
      }),
    );
    await user.type(
      within(dialog).getByLabelText('Verified field path'),
      'email_verified',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.created).toHaveLength(1));
    expect(calls.created[0]).toEqual({
      protocol: 'oauth2',
      name: 'Inhouse',
      enabled: false,
      jitProvisioning: false,
      authorizationEndpoint: 'https://sso.acme.com/authorize',
      tokenEndpoint: 'https://sso.acme.com/token',
      userinfoEndpoint: 'https://sso.acme.com/me',
      clientId: 'web',
      clientSecret: 'pw',
      tokenEndpointAuthMethod: 'client_secret_basic',
      scopes: ['profile', 'email'],
      mapping: {
        subject: 'sub',
        emailVerified: { path: 'email_verified' },
      },
    });
  });

  it('shows the API field errors on their fields', async () => {
    const { calls } = useSsoApi({ can: ADMIN, connections: [] });
    const user = userEvent.setup();
    await renderApp('/sso');
    const dialog = await openOAuth2Dialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Inhouse');
    await user.type(
      within(dialog).getByLabelText('Authorization URL'),
      'https://sso.acme.com/authorize',
    );
    // The form accepts http; the API refuses it (400 on the field).
    await user.type(
      within(dialog).getByLabelText('Token URL'),
      'http://sso.acme.com/token',
    );
    await user.type(
      within(dialog).getByLabelText('User info URL'),
      'https://sso.acme.com/me',
    );
    await user.type(within(dialog).getByLabelText('Client ID'), 'web');
    await user.type(within(dialog).getByLabelText('Client secret'), 'pw');
    await user.type(within(dialog).getByLabelText('Subject path'), 'sub');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText('Must be an https URL.'),
    ).toBeVisible();
    expect(within(dialog).getByText('Unknown path.')).toBeVisible();
    expect(calls.created).toHaveLength(1);
  });

  it('edits one without re-sending the secret, and cannot change the protocol', async () => {
    const { calls } = useSsoApi({ can: ADMIN, connections: [oauth2()] });
    const user = userEvent.setup();
    await renderApp('/sso');
    await screen.findByText('Lark');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).queryByRole('combobox', { name: 'Protocol' }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('combobox', { name: 'Provider preset' }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'https://app.example.com/v1/auth/sso/oauth2/callback',
      ),
    ).toBeVisible();
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Lark prod');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.patched).toHaveLength(1));
    const body = calls.patched[0]!.body;
    expect(body).not.toHaveProperty('clientSecret');
    expect(body).not.toHaveProperty('protocol');
    expect(body).toMatchObject({
      name: 'Lark prod',
      clientId: 'cli_a1b2c3',
      tokenEndpointAuthMethod: 'client_secret_post',
      scopes: ['contact:user.email:readonly'],
      mapping: {
        root: 'data',
        subject: 'open_id',
        emailVerified: 'verified-domains',
      },
    });
  });

  it('lists one as ready, with no discovery badge or refresh', async () => {
    useSsoApi({ can: ADMIN, connections: [oauth2()] });
    await renderApp('/sso');
    expect(await screen.findByText('Lark')).toBeVisible();
    expect(screen.getByText(/^Ready:/)).toBeVisible();
    expect(screen.queryByText(/Provider metadata/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Fetch metadata again' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('https://app.example.com/v1/auth/sso/oauth2/callback'),
    ).toBeVisible();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it } from 'vitest';
import { expectOverLimitRefused } from '@/test/limits';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';
import { findToast } from '@/test/toast';

// Made-up values: what the API shows once, at a create and at a rotation.
const CREATED = 'whsec_created-4711';
const ROTATED = 'whsec_rotated-4712';
const TENANT = '0199a3f2-0000-7000-8000-00000000a001';
const ID = '0199a3f2-0000-7000-8000-00000000b001';

const sender = (extra: object = {}) => ({
  id: ID,
  name: 'billing-system',
  description: 'Invoices' as string | null,
  enabled: true,
  path: `/v1/webhooks/tenants/${TENANT}/senders/billing-system`,
  previousSecretExpiresAt: null as string | null,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  ...extra,
});

function api(can = true) {
  const state = {
    senders: [sender()],
    created: undefined as unknown,
    patches: [] as unknown[],
    rotated: [] as unknown[],
    deleted: [] as string[],
  };
  server.use(
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        can: { 'Access.manageClients': can },
      }),
    ),
    http.get('/v1/features', () => HttpResponse.json(allFeatures)),
    http.get('/v1/access/clients', () => HttpResponse.json({ items: [] })),
    http.get('/v1/webhook-senders', () =>
      HttpResponse.json({ items: state.senders }),
    ),
    http.post('/v1/webhook-senders', async ({ request }) => {
      state.created = await request.json();
      const body = state.created as { name: string };
      const made = sender({
        id: '0199a3f2-0000-7000-8000-00000000b002',
        name: body.name,
        description: null,
        path: `/v1/webhooks/tenants/${TENANT}/senders/${body.name}`,
      });
      state.senders = [...state.senders, made];
      return HttpResponse.json({ ...made, secret: CREATED }, { status: 201 });
    }),
    http.patch('/v1/webhook-senders/:id', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      state.patches.push(body);
      state.senders = state.senders.map((s) => ({ ...s, ...body }));
      return HttpResponse.json(state.senders[0]);
    }),
    http.post('/v1/webhook-senders/:id/rotate-secret', async ({ request }) => {
      state.rotated.push(await request.json());
      state.senders = state.senders.map((s) => ({
        ...s,
        previousSecretExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }));
      return HttpResponse.json({ ...state.senders[0], secret: ROTATED });
    }),
    http.delete('/v1/webhook-senders/:id', ({ params }) => {
      state.deleted.push(String(params.id));
      state.senders = state.senders.filter((s) => s.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

const everywhere = (queryClient: {
  getQueryCache(): { getAll(): { state: { data: unknown } }[] };
  getMutationCache(): { getAll(): { state: { data: unknown } }[] };
}) =>
  JSON.stringify([
    ...queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
    ...queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data),
  ]);

describe('incoming webhook senders', () => {
  it('is reached from the webhooks page and lists the senders with their receiver URL', async () => {
    api();
    const user = userEvent.setup();
    await renderApp('/webhooks');
    await user.click(
      await screen.findByRole('button', { name: 'Incoming senders' }),
    );
    expect(await screen.findByText('billing-system')).toBeVisible();
    expect(screen.getByText('Invoices')).toBeVisible();
    expect(
      screen.getByText(
        `${window.location.origin}/v1/webhooks/tenants/${TENANT}/senders/billing-system`,
      ),
    ).toBeVisible();
  });

  it('creates a sender, shows the secret once and keeps it in no cache', async () => {
    const state = api();
    const user = userEvent.setup();
    const { queryClient } = await renderApp('/webhooks/senders');
    await screen.findByText('billing-system');

    await user.click(screen.getByRole('button', { name: 'New sender' }));
    const form = await screen.findByRole('dialog', { name: 'New sender' });
    await user.type(within(form).getByLabelText('Name'), 'crm');
    await user.click(
      within(form).getByRole('button', { name: 'Create sender' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Copy the signing secret',
    });
    expect(within(dialog).getByLabelText('Signing secret')).toHaveTextContent(
      CREATED,
    );
    expect(state.created).toEqual({ name: 'crm' });
    // While it is open, no query holds it (only the observed mutation).
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(CREATED);

    await user.click(
      within(dialog).getByRole('button', { name: 'I have copied it' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body).not.toHaveTextContent(CREATED);
    expect(everywhere(queryClient)).not.toContain(CREATED);
    expect(await screen.findByText('crm')).toBeVisible();
  });

  it('refuses an invalid name before asking the API', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/webhooks/senders');
    await screen.findByText('billing-system');
    await user.click(screen.getByRole('button', { name: 'New sender' }));
    const form = await screen.findByRole('dialog', { name: 'New sender' });
    await user.type(within(form).getByLabelText('Name'), 'Bad Name');
    await user.click(
      within(form).getByRole('button', { name: 'Create sender' }),
    );
    expect(
      await within(form).findByText(/Use lower-case letters/),
    ).toBeVisible();
    expect(state.created).toBeUndefined();
  });

  it('refuses a description over 500 characters before asking the API', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/webhooks/senders');
    await screen.findByText('billing-system');
    await user.click(screen.getByRole('button', { name: 'New sender' }));
    const form = await screen.findByRole('dialog', { name: 'New sender' });
    await user.type(within(form).getByLabelText('Name'), 'crm');
    await expectOverLimitRefused(user, {
      scope: form,
      label: 'Description (optional)',
      max: 500,
      submit: 'Create sender',
    });
    expect(state.created).toBeUndefined();
  });

  it("shows the API's refusal of a taken name and keeps the dialog open", async () => {
    api();
    server.use(
      http.post('/v1/webhook-senders', () =>
        problem(409, 'conflict', { detail: 'The name is taken.' }),
      ),
    );
    const user = userEvent.setup();
    await renderApp('/webhooks/senders');
    await screen.findByText('billing-system');
    await user.click(screen.getByRole('button', { name: 'New sender' }));
    const form = await screen.findByRole('dialog', { name: 'New sender' });
    await user.type(within(form).getByLabelText('Name'), 'billing-system');
    await user.click(
      within(form).getByRole('button', { name: 'Create sender' }),
    );
    expect(await within(form).findByText('The name is taken.')).toBeVisible();
  });

  it('switches a sender off, edits its description and clears it', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/webhooks/senders');
    await screen.findByText('billing-system');

    await user.click(
      screen.getByRole('switch', { name: 'billing-system may send' }),
    );
    expect(
      await findToast('Sender switched off: its calls are refused.'),
    ).toBeVisible();
    expect(state.patches).toEqual([{ enabled: false }]);

    await user.click(
      screen.getByRole('button', { name: 'Edit billing-system' }),
    );
    const form = await screen.findByRole('dialog', { name: 'Edit sender' });
    await user.clear(within(form).getByLabelText('Description (optional)'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.patches).toHaveLength(2));
    expect(state.patches[1]).toEqual({ description: null });
  });

  it('rotates the secret after a confirmation and shows it once', async () => {
    const state = api();
    const user = userEvent.setup();
    const { queryClient } = await renderApp('/webhooks/senders');
    await screen.findByText('billing-system');

    await user.click(
      screen.getByRole('button', {
        name: 'Rotate the secret of billing-system',
      }),
    );
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Rotate' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Copy the new signing secret',
    });
    expect(within(dialog).getByLabelText('Signing secret')).toHaveTextContent(
      ROTATED,
    );
    expect(state.rotated).toEqual([{}]);
    expect(await screen.findByText(/Old secret valid until/)).toBeVisible();
    await user.click(
      within(dialog).getByRole('button', { name: 'I have copied it' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(everywhere(queryClient)).not.toContain(ROTATED);
  });

  it('deletes a sender after a confirmation', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp('/webhooks/senders');
    await screen.findByText('billing-system');
    await user.click(
      screen.getByRole('button', { name: 'Delete billing-system' }),
    );
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No senders yet.')).toBeVisible();
    expect(state.deleted).toEqual([ID]);
  });

  it('sends whoever may not manage clients away from the page', async () => {
    api(false);
    await renderApp('/webhooks/senders');
    await waitFor(() =>
      expect(screen.queryByText('Incoming webhook senders')).toBeNull(),
    );
    expect(screen.queryByRole('button', { name: 'New sender' })).toBeNull();
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw/http';
import { describe, expect, it, vi } from 'vitest';
import { expectOverLimitRefused } from '@/test/limits';
import { renderApp } from '@/test/render-app';
import { allFeatures, problem, server, signedInUser } from '@/test/server';

// Made-up values: what the API shows once, at a create and at a rotation.
const CREATED = 'signing-value-created-4711';
const ROTATED = 'signing-value-rotated-4712';
const CLIENT = '0199a3f2-0000-7000-8000-00000000c001';
const EP = '0199a3f2-0000-7000-8000-00000000e001';
const DEL = '0199a3f2-0000-7000-8000-00000000d001';
const DEL_OK = '0199a3f2-0000-7000-8000-00000000d002';
const base = `/v1/access/clients/:clientId`;
const BODY = '{"note":"<img src=x onerror=alert(1)>","n":1}';

const endpoint = (extra: object = {}) => ({
  id: EP,
  tenant: CLIENT,
  url: 'https://hooks.example.com/in',
  eventTypes: ['note.created'],
  description: 'Warehouse' as string | null,
  enabled: true,
  disabledReason: null as string | null,
  failingSince: null,
  createdAt: Date.parse('2026-10-10T08:00:00Z'),
  updatedAt: Date.parse('2026-10-10T08:00:00Z'),
  ...extra,
});

const delivery = (id: string, extra: object = {}) => ({
  id,
  messageId: `msg_${id.slice(-4)}`,
  endpointId: EP,
  tenant: CLIENT,
  type: 'note.created',
  status: 'failed',
  attempts: 3,
  nextAttemptAt: null,
  lastAttemptAt: '2026-10-11T08:00:00.000Z',
  lastStatusCode: 500,
  lastError: null,
  failureReason: 'exhausted',
  createdAt: '2026-10-11T07:00:00.000Z',
  completedAt: null,
  ...extra,
});

const client = () => ({
  id: CLIENT,
  name: 'Billing exporter',
  active: true,
  dailyQuota: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  keys: [],
  roles: [],
});

/** GET /v1/lists/WebhookDelivery, as the API describes the delivery log. */
const deliveryList = {
  subject: 'WebhookDelivery',
  fields: [
    {
      name: 'endpointId',
      type: 'string',
      operators: ['eq', 'in'],
      sortable: false,
      custom: false,
    },
    {
      name: 'status',
      type: 'enum',
      options: ['pending', 'succeeded', 'failed'],
      operators: ['eq', 'in'],
      sortable: false,
      custom: false,
    },
    {
      name: 'type',
      type: 'string',
      operators: ['eq', 'in', 'startsWith'],
      sortable: true,
      custom: false,
    },
    {
      name: 'attempts',
      type: 'number',
      operators: ['gte', 'lte'],
      sortable: true,
      custom: false,
    },
    {
      name: 'createdAt',
      type: 'datetime',
      operators: ['gt', 'gte', 'lt', 'lte', 'between'],
      sortable: false,
      custom: false,
    },
  ],
  select: [
    'id',
    'messageId',
    'endpointId',
    'type',
    'status',
    'attempts',
    'lastStatusCode',
    'lastError',
    'createdAt',
  ],
  search: false,
  recycleBin: false,
  defaultSort: null,
  limits: { defaultLimit: 50, maxLimit: 100 },
};

type Condition = { field: string; op: string; value: unknown };

function api(
  options: { features?: Partial<typeof allFeatures>; can?: boolean } = {},
) {
  const state = {
    endpoints: [endpoint()],
    deliveries: [
      delivery(DEL),
      delivery(DEL_OK, {
        status: 'succeeded',
        lastStatusCode: 200,
        failureReason: null,
        type: 'note.updated',
      }),
    ],
    created: undefined as unknown,
    patches: [] as unknown[],
    deleted: [] as string[],
    rotated: 0,
    tests: 0,
    retried: [] as string[],
    retryFailed: [] as unknown[],
    deliveryQueries: [] as URLSearchParams[],
    descriptions: 0,
    scope: 'own' as 'own' | 'tenant',
    scopes: [] as unknown[],
  };
  server.use(
    http.get('/v1/lists/WebhookDelivery', () => {
      state.descriptions += 1;
      return HttpResponse.json(deliveryList);
    }),
    http.get('/v1/auth/me', () =>
      HttpResponse.json({
        ...signedInUser,
        can: { 'Access.manageClients': options.can ?? true },
      }),
    ),
    http.get('/v1/features', () =>
      HttpResponse.json({ ...allFeatures, ...options.features }),
    ),
    http.get('/v1/access/clients', () =>
      HttpResponse.json({ items: [client()] }),
    ),
    http.get('/v1/access/clients/:id', ({ params }) =>
      params.id === CLIENT
        ? HttpResponse.json(client())
        : problem(404, 'not_found'),
    ),
    http.get('/v1/webhook-event-types', () =>
      HttpResponse.json({
        items: [
          {
            group: 'note',
            types: [
              { type: 'note.created', description: 'A note was created' },
              { type: 'note.updated', description: null },
            ],
          },
          {
            group: 'approval',
            types: [{ type: 'approval.requested', description: null }],
          },
        ],
      }),
    ),
    http.get(`${base}/webhook-scope`, () =>
      HttpResponse.json({ scope: state.scope }),
    ),
    http.put(`${base}/webhook-scope`, async ({ request }) => {
      const body = (await request.json()) as { scope: 'own' | 'tenant' };
      state.scopes.push(body);
      state.scope = body.scope;
      return HttpResponse.json(body);
    }),
    http.get(`${base}/webhook-endpoints`, () =>
      HttpResponse.json({ items: state.endpoints }),
    ),
    http.post(`${base}/webhook-endpoints`, async ({ request }) => {
      state.created = await request.json();
      const body = state.created as { url: string; eventTypes: string[] };
      const made = endpoint({
        id: '0199a3f2-0000-7000-8000-00000000e002',
        url: body.url,
        eventTypes: body.eventTypes,
        description: null,
      });
      state.endpoints = [...state.endpoints, made];
      return HttpResponse.json({ ...made, secret: CREATED }, { status: 201 });
    }),
    http.get(`${base}/webhook-endpoints/:id`, ({ params }) => {
      const found = state.endpoints.find((entry) => entry.id === params.id);
      return found ? HttpResponse.json(found) : problem(404, 'not_found');
    }),
    http.patch(`${base}/webhook-endpoints/:id`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      state.patches.push(body);
      state.endpoints = state.endpoints.map((entry) => ({
        ...entry,
        ...body,
        ...(body.enabled === false && { disabledReason: 'manual' }),
        updatedAt: Date.now(),
      }));
      return HttpResponse.json(state.endpoints[0]);
    }),
    http.delete(`${base}/webhook-endpoints/:id`, ({ params }) => {
      state.deleted.push(String(params.id));
      state.endpoints = state.endpoints.filter((e) => e.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${base}/webhook-endpoints/:id/rotate-secret`, () => {
      state.rotated += 1;
      return HttpResponse.json({ secret: ROTATED });
    }),
    http.post(`${base}/webhook-endpoints/:id/test`, () => {
      state.tests += 1;
      const made = delivery('0199a3f2-0000-7000-8000-00000000d003', {
        type: 'webhook.test',
        status: 'succeeded',
        lastStatusCode: 204,
        failureReason: null,
      });
      state.deliveries = [made, ...state.deliveries];
      return HttpResponse.json(made, { status: 202 });
    }),
    http.get(`${base}/webhook-deliveries`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      state.deliveryQueries.push(query);
      const conditions: Condition[] =
        JSON.parse(query.get('filter') ?? 'null')?.and ?? [];
      const matches = (d: Record<string, unknown>, c: Condition) =>
        c.op === 'eq'
          ? d[c.field] === c.value
          : (c.value as unknown[]).includes(d[c.field]);
      const items = state.deliveries.filter(
        (d) =>
          (!query.get('endpointId') ||
            d.endpointId === query.get('endpointId')) &&
          conditions.every((c) => matches(d, c)),
      );
      const limit = Number(query.get('limit') ?? 50);
      const page = Number(query.get('page') ?? 1);
      return HttpResponse.json({
        items: items.slice((page - 1) * limit, page * limit),
        nextCursor: null,
        page,
        nextPage: page * limit < items.length ? page + 1 : null,
        pageCount: Math.max(1, Math.ceil(items.length / limit)),
        total: items.length,
      });
    }),
    http.get(`${base}/webhook-deliveries/:id`, ({ params }) => {
      const found = state.deliveries.find((d) => d.id === params.id)!;
      return HttpResponse.json({
        ...found,
        message: {
          id: 'm1',
          type: found.type,
          tenant: CLIENT,
          body: BODY,
          createdAt: found.createdAt,
        },
        history: [
          {
            deliveryId: found.id,
            attempt: 1,
            at: found.createdAt,
            durationMs: 120,
            statusCode: 500,
            response: '<script>window.pwned = true</script> upstream down',
            error: null,
          },
        ],
        durationMs: 120,
        lastRequest: {
          attempt: 1,
          sentAt: found.createdAt,
          headers: {
            'webhook-id': 'msg_d001',
            'webhook-signature': 'v1,abc',
            'content-type': 'application/json',
          },
        },
      });
    }),
    http.post(`${base}/webhook-deliveries/retry`, async ({ request }) => {
      state.retryFailed.push(await request.json());
      return HttpResponse.json({ retried: 2 });
    }),
    http.post(`${base}/webhook-deliveries/:id/retry`, ({ params }) => {
      state.retried.push(String(params.id));
      return HttpResponse.json({ retried: 1 });
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

const endpointsPath = `/webhooks/${CLIENT}`;
const detailPath = `/webhooks/${CLIENT}/${EP}`;
const heading = { name: 'https://hooks.example.com/in' };

describe('clients and endpoints', () => {
  it('lists the clients, then the endpoints of the one picked', async () => {
    api();
    const user = userEvent.setup();
    await renderApp('/webhooks');
    await user.click(
      await screen.findByRole('link', { name: 'Billing exporter' }),
    );
    expect(
      await screen.findByRole('link', { name: 'https://hooks.example.com/in' }),
    ).toBeVisible();
    expect(screen.getByText('Warehouse')).toBeVisible();
    expect(screen.getByText('1 event type')).toBeVisible();
  });

  it("widens the client's events to the tenant's records it may read, and back", async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(endpointsPath);
    const scope = await screen.findByRole('switch', {
      name: "Also send events about the tenant's other records",
    });
    expect(scope).not.toBeChecked();
    await user.click(scope);
    await waitFor(() => expect(scope).toBeChecked());
    await user.click(scope);
    await waitFor(() => expect(scope).not.toBeChecked());
    expect(state.scopes).toEqual([{ scope: 'tenant' }, { scope: 'own' }]);
  });

  it('creates an endpoint from the catalog, shows the secret once and keeps it nowhere', async () => {
    const state = api();
    const user = userEvent.setup();
    const { queryClient } = await renderApp(endpointsPath);
    await screen.findByText('https://hooks.example.com/in');

    await user.click(screen.getByRole('button', { name: 'New endpoint' }));
    const form = await screen.findByRole('dialog', { name: 'New endpoint' });
    await user.type(
      within(form).getByLabelText('URL'),
      'https://other.example.com/hook',
    );
    // From all events to chosen ones, grouped by feature.
    await user.click(
      within(form).getByRole('checkbox', { name: 'All events' }),
    );
    expect(await within(form).findByText('approval')).toBeVisible();
    await user.click(within(form).getByRole('checkbox', { name: 'note' }));
    await user.click(
      within(form).getByRole('button', { name: 'Create endpoint' }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: 'Copy the signing secret',
    });
    expect(within(dialog).getByLabelText('Signing secret')).toHaveTextContent(
      CREATED,
    );
    expect(dialog).toHaveTextContent("You won't see this secret again");
    expect(state.created).toEqual({
      url: 'https://other.example.com/hook',
      eventTypes: expect.arrayContaining(['note.created', 'note.updated']),
    });

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
    expect(
      await screen.findByText('https://other.example.com/hook'),
    ).toBeVisible();
  });

  it('refuses an address that is not a web address before asking the API', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(endpointsPath);
    await screen.findByText('https://hooks.example.com/in');
    await user.click(screen.getByRole('button', { name: 'New endpoint' }));
    const form = await screen.findByRole('dialog', { name: 'New endpoint' });
    await user.type(within(form).getByLabelText('URL'), 'not a url');
    await user.click(
      within(form).getByRole('button', { name: 'Create endpoint' }),
    );
    expect(
      await within(form).findByText(/Enter a full web address/),
    ).toBeVisible();
    expect(state.created).toBeUndefined();
  });

  it('refuses a description over 500 characters before asking the API', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(endpointsPath);
    await screen.findByText('https://hooks.example.com/in');
    await user.click(screen.getByRole('button', { name: 'New endpoint' }));
    const form = await screen.findByRole('dialog', { name: 'New endpoint' });
    await user.type(
      within(form).getByLabelText('URL'),
      'https://other.example.com/hook',
    );
    await expectOverLimitRefused(user, {
      scope: form,
      label: 'Description (optional)',
      max: 500,
      submit: 'Create endpoint',
    });
    expect(state.created).toBeUndefined();
  });

  it("shows the API's refusal in the dialog and keeps it open", async () => {
    api();
    server.use(
      http.post(`${base}/webhook-endpoints`, () =>
        problem(400, 'validation_failed', {
          detail: 'The address is private.',
          errors: [{ path: 'url', message: 'The address is private.' }],
        }),
      ),
    );
    const user = userEvent.setup();
    await renderApp(endpointsPath);
    await screen.findByText('https://hooks.example.com/in');
    await user.click(screen.getByRole('button', { name: 'New endpoint' }));
    const form = await screen.findByRole('dialog', { name: 'New endpoint' });
    await user.type(within(form).getByLabelText('URL'), 'https://10.0.0.1/x');
    await user.click(
      within(form).getByRole('button', { name: 'Create endpoint' }),
    );
    expect(
      await within(form).findByText('The address is private.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('dialog', { name: 'Copy the signing secret' }),
    ).toBeNull();
  });
});

describe('an endpoint', () => {
  it('edits the URL, description and events, and clears the description with null', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(detailPath);
    await screen.findByRole('heading', heading);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = await screen.findByRole('dialog', { name: 'Edit endpoint' });
    const url = within(form).getByLabelText('URL');
    await user.clear(url);
    await user.type(url, 'https://new.example.com/in');
    await user.clear(within(form).getByLabelText('Description (optional)'));
    // note.created is ticked; add note.updated.
    expect(
      await within(form).findByRole('checkbox', { name: /note\.created/ }),
    ).toBeChecked();
    await user.click(
      within(form).getByRole('checkbox', { name: /note\.updated/ }),
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.patches).toHaveLength(1));
    expect(state.patches[0]).toEqual({
      url: 'https://new.example.com/in',
      description: null,
      eventTypes: expect.arrayContaining(['note.created', 'note.updated']),
    });
    expect(
      await screen.findByRole('heading', {
        name: 'https://new.example.com/in',
      }),
    ).toBeVisible();
  });

  it('switches it off', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(detailPath);
    await screen.findByRole('heading', heading);
    await user.click(screen.getByRole('switch', { name: 'Receives events' }));
    await waitFor(() => expect(state.patches).toEqual([{ enabled: false }]));
    expect(await screen.findByText('Switched off')).toBeVisible();
  });

  it('rotates the secret after asking, shows it once and keeps it nowhere', async () => {
    const state = api();
    const user = userEvent.setup();
    const { queryClient } = await renderApp(detailPath);
    await screen.findByRole('heading', heading);
    await user.click(screen.getByRole('button', { name: 'Rotate secret' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(state.rotated).toBe(0);
    await user.click(within(confirm).getByRole('button', { name: 'Rotate' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Copy the new signing secret',
    });
    expect(within(dialog).getByLabelText('Signing secret')).toHaveTextContent(
      ROTATED,
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'I have copied it' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body).not.toHaveTextContent(ROTATED);
    expect(everywhere(queryClient)).not.toContain(ROTATED);
  });

  it('deletes it after asking and goes back to the list', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(detailPath);
    await screen.findByRole('heading', heading);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(state.deleted).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(state.deleted).toEqual([EP]));
    expect(await screen.findByText('No endpoints yet.')).toBeVisible();
  });

  it('says so when there is no such endpoint', async () => {
    api();
    await renderApp(`/webhooks/${CLIENT}/0199a3f2-0000-7000-8000-00000000ffff`);
    expect(await screen.findByText('No such endpoint.')).toBeVisible();
  });
});

describe('deliveries', () => {
  it('sends a test event and shows the delivery it made', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(detailPath);
    await screen.findAllByRole('button', { name: 'note.created' });
    await user.click(screen.getByRole('button', { name: 'Send test event' }));
    expect(
      await screen.findByRole('button', { name: 'webhook.test' }),
    ).toBeVisible();
    expect(state.tests).toBe(1);
  });

  it("lists this endpoint's deliveries on the list page, by the list's description", async () => {
    const state = api();
    await renderApp(detailPath);
    expect(
      await screen.findByRole('button', { name: 'note.updated' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Deliveries' })).toBeVisible();
    expect(state.descriptions).toBe(1);
    const asked = state.deliveryQueries.at(-1)!;
    expect(asked.get('endpointId')).toBe(EP);
    expect(asked.get('page')).toBe('1');
    expect(asked.get('limit')).toBe('20');
    // The list has no default sort: none is sent.
    expect(asked.get('sort')).toBeNull();
    expect(asked.get('fields')).toBe(
      'type,status,attempts,lastStatusCode,lastError,createdAt',
    );
  });

  it('filters by status, as the URL says', async () => {
    const state = api();
    await renderApp(`${detailPath}?status=in.failed`);
    await screen.findAllByRole('button', { name: 'note.created' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'note.updated' })).toBeNull(),
    );
    const asked = state.deliveryQueries.at(-1)!;
    expect(JSON.parse(asked.get('filter') ?? 'null')).toEqual({
      and: [{ field: 'status', op: 'in', value: ['failed'] }],
    });
    expect(asked.get('endpointId')).toBe(EP);
  });

  it('offers the filters the list describes, and none it does not', async () => {
    api();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = () => {};
    const user = userEvent.setup();
    await renderApp(detailPath);
    await screen.findByRole('button', { name: 'note.updated' });
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(await screen.findByRole('button', { name: 'Add filter' }));
    // The first filterable column is the event; open the list of columns.
    // The column's header is a button too: the picker is the last one.
    await user.click(screen.getAllByRole('button', { name: 'Event' }).at(-1)!);
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Event',
      'Status',
      'Attempts',
      'Created',
    ]);
  });

  it('pages by number on the server', async () => {
    const state = api();
    state.deliveries = Array.from({ length: 23 }, (_, index) =>
      delivery(
        `0199a3f2-0000-7000-8000-0000000d${String(index).padStart(4, '0')}`,
        {
          type: `order.${index}`,
        },
      ),
    );
    const user = userEvent.setup();
    await renderApp(detailPath);
    expect(
      await screen.findByRole('button', { name: 'order.0' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'order.22' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /next page/i }));
    expect(
      await screen.findByRole('button', { name: 'order.22' }),
    ).toBeVisible();
    expect(state.deliveryQueries.at(-1)?.get('page')).toBe('2');
  });

  it('says so when the endpoint has no deliveries yet', async () => {
    const state = api();
    state.deliveries = [];
    await renderApp(detailPath);
    expect(await screen.findByText('Nothing here yet')).toBeVisible();
  });

  it('opens a delivery with its request and response, the payload as text only', async () => {
    api();
    const user = userEvent.setup();
    await renderApp(detailPath);
    await user.click(
      (await screen.findAllByRole('button', { name: 'note.created' }))[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delivery' });
    const payload = await within(dialog).findByLabelText('Payload');
    // Indented JSON, markup left as characters.
    expect(payload).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(payload.querySelector('img')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull();
    const response = within(dialog).getByLabelText('Response of attempt 1');
    expect(response).toHaveTextContent('<script>window.pwned = true</script>');
    expect(response.querySelector('script')).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(within(dialog).getByLabelText('Request headers')).toHaveTextContent(
      'webhook-signature: v1,abc',
    );
    expect(dialog).toHaveTextContent('Attempt 1');
  });

  it('retries one delivery', async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(detailPath);
    await user.click(
      (await screen.findAllByRole('button', { name: 'note.created' }))[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Delivery' });
    await within(dialog).findByLabelText('Payload');
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(state.retried).toEqual([DEL]));
  });

  it("retries the endpoint's failed deliveries, since a time if given", async () => {
    const state = api();
    const user = userEvent.setup();
    await renderApp(detailPath);
    await screen.findAllByRole('button', { name: 'note.created' });
    await user.click(screen.getByRole('button', { name: 'Retry failed' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Retry the failed deliveries?',
    });
    await user.type(
      within(dialog).getByLabelText(/Only those created since/),
      '2026-10-11T06:00',
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Retry failed' }),
    );
    await waitFor(() => expect(state.retryFailed).toHaveLength(1));
    expect(state.retryFailed[0]).toEqual({
      endpointId: EP,
      since: new Date('2026-10-11T06:00').toISOString(),
    });
  });
});

describe('gating', () => {
  it('has an entry for an administrator of clients', async () => {
    api();
    await renderApp('/webhooks');
    expect(await screen.findByRole('link', { name: 'Webhooks' })).toBeVisible();
  });

  it('has no entry and no route with webhooks off', async () => {
    api({ features: { webhooks: false } });
    await renderApp('/webhooks');
    expect(await screen.findByText('Page not found')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Webhooks' })).toBeNull();
  });

  it('has no route with apiClients off: the API refuses it', async () => {
    api({ features: { apiClients: false } });
    await renderApp(endpointsPath);
    expect(await screen.findByText('Page not found')).toBeVisible();
  });

  it('hides the entry from a user without the permission and sends them to the dashboard', async () => {
    api({ can: false });
    await renderApp('/webhooks');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(screen.queryByRole('link', { name: 'Webhooks' })).toBeNull();
  });
});

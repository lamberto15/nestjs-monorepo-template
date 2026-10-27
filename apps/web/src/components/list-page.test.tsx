import { createApiClient } from '@nestjs-monorepo-template/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import de from '@/locales/de/common.json';
import en from '@/locales/en/common.json';
import { recordKeys } from '@/lib/records';
import { ListPage, type ListPageProps } from './list-page';
import type { ListColumn, ListPath } from '@/lib/list-query';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
// The real client on a mocked fetch: the URLs it builds are what is checked.
vi.mock('@/lib/api', () => ({
  api: createApiClient({
    baseUrl: 'http://api.test',
    fetch: (input: RequestInfo | URL) =>
      mocks.fetch(input) as Promise<Response>,
  }),
}));

// A test-only subject's list (as the API's tests use TestItem): ListPage is
// the same for every list route, so no feature's route is needed.
const PATH = '/v1/test-items';
type Row = {
  id: string;
  title: string;
  status: string;
  custom?: Record<string, unknown>;
};
/**
 * ListPage on that list. Its `path` is typed on the client's list routes,
 * which have no test-only one: the one cast, here.
 */
const TestListPage = ListPage as unknown as (
  props: Omit<ListPageProps<ListPath>, 'path' | 'columns'> & {
    path: string;
    columns: ListColumn<Row>[];
  },
) => ReactNode;

const description = {
  subject: 'TestItem',
  fields: [
    {
      name: 'title',
      type: 'string',
      operators: ['contains'],
      sortable: true,
      custom: false,
    },
    {
      name: 'status',
      type: 'enum',
      options: ['draft', 'published'],
      operators: ['eq', 'in'],
      sortable: true,
      custom: false,
    },
  ],
  select: ['title', 'status'],
  search: true,
  recycleBin: false,
  defaultSort: '-createdAt',
  limits: { defaultLimit: 50, maxLimit: 100 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type':
        status < 400 ? 'application/json' : 'application/problem+json',
    },
  });

const columns: ListColumn<Row>[] = [
  {
    id: 'title',
    accessorKey: 'title',
    meta: { label: 'Title' },
    header: 'Title',
  },
  {
    id: 'status',
    accessorKey: 'status',
    meta: { label: 'Status' },
    header: 'Status',
  },
];

async function renderList(
  searchParams = '',
  lng: 'en' | 'de' = 'en',
  props: Partial<Parameters<typeof TestListPage>[0]> = {},
) {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    resources: { en: { common: en }, de: { common: de } },
    defaultNS: 'common',
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <NuqsTestingAdapter searchParams={searchParams} hasMemory>
          <TestListPage
            subject="TestItem"
            path={PATH}
            title="Test items"
            columns={columns}
            {...props}
          />
        </NuqsTestingAdapter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return Object.assign(rendered, { client });
}

const urls = () =>
  mocks.fetch.mock.calls.map(([request]) => new URL((request as Request).url));

describe('ListPage', () => {
  beforeEach(() => mocks.fetch.mockReset());

  it('shows a skeleton, then the rows of the page', async () => {
    mocks.fetch.mockImplementation(async (request?: Request) =>
      request?.url.includes('/v1/lists/')
        ? json(description)
        : json({
            items: [{ id: '1', title: 'First item', status: 'draft' }],
            nextCursor: null,
            page: 1,
            nextPage: null,
            pageCount: 1,
            total: 1,
          }),
    );
    await renderList();

    expect(await screen.findByText('First item')).toBeInTheDocument();
    const list = urls().find((url) => url.pathname === PATH);
    expect(list?.searchParams.get('page')).toBe('1');
    expect(list?.searchParams.get('limit')).toBe('20');
    expect(list?.searchParams.get('count')).toBe('true');
    expect(list?.searchParams.get('sort')).toBe('-createdAt');
    expect(list?.searchParams.get('fields')).toBe('title,status');
  });

  it("keeps its pages under the feature's list key, where a write refreshes them", async () => {
    mocks.fetch.mockImplementation(async (request?: Request) =>
      request?.url.includes('/v1/lists/')
        ? json(description)
        : json({
            items: [{ id: '1', title: 'First item', status: 'draft' }],
            nextCursor: null,
            page: 1,
            nextPage: null,
            pageCount: 1,
            total: 1,
          }),
    );
    const { client } = await renderList();
    await screen.findByText('First item');
    const pages = client
      .getQueryCache()
      .findAll({ queryKey: recordKeys.lists(PATH) });
    expect(pages).toHaveLength(1);
    // The list route, then the page's params (no placeholders on this route).
    expect(pages[0]!.queryKey).toHaveLength(3);
    await client.invalidateQueries({ queryKey: recordKeys.lists(PATH) });
    expect(
      urls().filter((url) => url.pathname === PATH).length,
    ).toBeGreaterThan(1);
  });

  it("fills the route's placeholders, and heads and describes the list as asked", async () => {
    mocks.fetch.mockImplementation(async (request?: Request) =>
      request?.url.includes('/v1/lists/')
        ? json(description)
        : json({
            items: [{ id: '1', title: 'First item', status: 'draft' }],
            nextCursor: null,
            page: 1,
            nextPage: null,
            pageCount: 1,
            total: 1,
          }),
    );
    await renderList('', 'en', {
      path: '/v1/parents/{parentId}/items',
      pathParams: { parentId: 'p-1' },
      query: { fixed: 'yes' },
      subtitle: 'What the parent holds.',
      headingLevel: 2,
    });

    expect(await screen.findByText('First item')).toBeInTheDocument();
    const list = urls().find((url) => url.pathname === '/v1/parents/p-1/items');
    expect(list?.searchParams.get('fixed')).toBe('yes');
    expect(
      screen.getByRole('heading', { level: 2, name: 'Test items' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByText('What the parent holds.')).toBeInTheDocument();
  });

  it('asks again while its rows say they are not settled', async () => {
    let calls = 0;
    mocks.fetch.mockImplementation(async (request?: Request) => {
      if (request?.url.includes('/v1/lists/')) return json(description);
      calls++;
      return json({
        items: [
          {
            id: '1',
            title: 'First item',
            status: calls < 2 ? 'draft' : 'published',
          },
        ],
        nextCursor: null,
        page: 1,
        nextPage: null,
        pageCount: 1,
        total: 1,
      });
    });
    await renderList('', 'en', {
      refetchInterval: (rows: unknown[]) =>
        (rows as Row[]).some((row) => row.status === 'draft') ? 50 : false,
    });

    expect(await screen.findByText('published')).toBeInTheDocument();
    const settled = calls;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(settled);
  });

  it("sends the URL's filter as the API's JSON", async () => {
    mocks.fetch.mockImplementation(async (request?: Request) =>
      request?.url.includes('/v1/lists/')
        ? json(description)
        : json({
            items: [],
            nextCursor: null,
            page: 1,
            pageCount: 0,
            total: 0,
          }),
    );
    await renderList('?title=report&sort=title.asc&q=hello');

    await waitFor(() =>
      expect(urls().some((url) => url.pathname === PATH)).toBe(true),
    );
    const list = urls().find((url) => url.pathname === PATH);
    expect(JSON.parse(list?.searchParams.get('filter') ?? 'null')).toEqual({
      and: [{ field: 'title', op: 'contains', value: 'report' }],
    });
    expect(list?.searchParams.get('sort')).toBe('title');
    expect(list?.searchParams.get('q')).toBe('hello');
  });

  it('says so when there is nothing, and when the API fails', async () => {
    mocks.fetch.mockImplementation(async (request?: Request) =>
      request?.url.includes('/v1/lists/')
        ? json(description)
        : json({
            items: [],
            nextCursor: null,
            page: 1,
            pageCount: 0,
            total: 0,
          }),
    );
    const first = await renderList();
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
    first.unmount();

    mocks.fetch.mockImplementation(async (request?: Request) =>
      request?.url.includes('/v1/lists/')
        ? json(description)
        : json(
            {
              status: 403,
              code: 'forbidden',
              detail: 'You may not read test items.',
            },
            403,
          ),
    );
    await renderList();
    expect(
      await screen.findByText('You may not read test items.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  const respond = (list: unknown, extra: Record<string, unknown> = {}) =>
    mocks.fetch.mockImplementation(async (request?: Request) => {
      const url = request?.url ?? '';
      if (url.includes('/v1/lists/')) return json(list);
      if (url.includes('/v1/tags')) return json(extra.tags);
      if (url.includes('/v1/people')) {
        const people = extra.people as (url: URL) => unknown;
        return json(people(new URL(url)));
      }
      if (url.includes('/v1/teams')) {
        return json(extra.teams ?? { items: [], nextCursor: null });
      }
      // A member's session: none of the administrators' routes.
      if (url.includes('/v1/access/')) {
        return json({ status: 403, code: 'forbidden', detail: 'No.' }, 403);
      }
      return json({
        items: (extra.rows as object[] | undefined) ?? [
          {
            id: '1',
            title: 'First',
            status: 'draft',
            custom: { region: 'eu' },
          },
        ],
        nextCursor: null,
        page: 1,
        pageCount: 1,
        total: 1,
      });
    });

  it('adds the custom fields as hidden columns, and sends custom.<key>', async () => {
    const custom = {
      name: 'custom.region',
      type: 'enum',
      options: ['eu', 'us'],
      operators: ['eq', 'in'],
      sortable: true,
      custom: true,
      label: 'Region',
    };
    respond({
      ...description,
      fields: [...description.fields, custom],
      select: [...description.select, 'custom.region'],
    });
    await renderList('?custom.region=in.eu&sort=custom.region.asc');

    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /Region/ }),
    ).not.toBeInTheDocument();
    const list = urls().find((url) => url.pathname === PATH);
    expect(list?.searchParams.get('fields')).toBe('title,status');
    expect(list?.searchParams.get('sort')).toBe('custom.region');
    expect(JSON.parse(list?.searchParams.get('filter') ?? 'null')).toEqual({
      and: [{ field: 'custom.region', op: 'in', value: ['eu'] }],
    });

    // jsdom has neither, and the popover and the list measure and scroll.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = () => {};
    await userEvent.click(screen.getByRole('button', { name: 'View columns' }));
    await userEvent.click(await screen.findByText('Region'));
    await waitFor(() => {
      const last = urls()
        .filter((url) => url.pathname === PATH)
        .at(-1);
      expect(last?.searchParams.get('fields')).toBe(
        'title,status,custom.region',
      );
    });
  });

  it("filters by the tenant's tags through the tag picker", async () => {
    respond(
      {
        ...description,
        fields: [
          ...description.fields,
          {
            name: 'tag',
            type: 'uuid',
            operators: ['eq', 'in'],
            sortable: false,
            custom: false,
            ref: 'tag',
          },
        ],
      },
      { tags: { items: [{ id: 't1', name: 'Urgent', color: '#ef4444' }] } },
    );
    await renderList('?tag=in.t1');

    expect(await screen.findByText('First')).toBeInTheDocument();
    const tags = urls().find((url) => url.pathname === '/v1/tags');
    expect(tags?.searchParams.get('subject')).toBe('TestItem');
    const list = urls().find((url) => url.pathname === PATH);
    expect(JSON.parse(list?.searchParams.get('filter') ?? 'null')).toEqual({
      and: [{ field: 'tag', op: 'in', value: ['t1'] }],
    });
    // Never a column of its own, never asked for.
    expect(list?.searchParams.get('fields')).toBe('title,status');
  });

  // jsdom has neither, and the popovers and the lists measure and scroll.
  const stubLayout = () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView = () => {};
  };

  const withRefs = {
    ...description,
    fields: [
      ...description.fields,
      {
        name: 'ownerId',
        type: 'string',
        operators: ['eq'],
        sortable: false,
        custom: false,
        ref: 'principal',
      },
      {
        name: 'teamId',
        type: 'uuid',
        operators: ['eq', 'in', 'isNull'],
        sortable: false,
        custom: false,
        ref: 'team',
      },
    ],
    select: [...description.select, 'ownerId', 'teamId'],
  };

  it('filters by a user found by name, and names them in the filter', async () => {
    stubLayout();
    respond(withRefs, {
      // Found by name: nobody before the search.
      people: (url: URL) => ({
        items:
          url.searchParams.get('q') === 'ad'
            ? [{ key: 'user:1', name: 'Ada Lovelace' }]
            : [{ key: 'user:2', name: 'Grace Hopper' }],
      }),
    });
    await renderList();
    expect(await screen.findByText('First')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add filter' }),
    );
    // The first filterable column is the title: pick the owner instead.
    await userEvent.click(screen.getByRole('button', { name: 'Title' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Owner' }));
    await userEvent.click(
      await screen.findByRole('button', { name: /Owner filter value/i }),
    );
    await userEvent.type(
      await screen.findByLabelText('Search Owner options'),
      'ad',
    );
    await userEvent.click(
      await screen.findByText('Ada Lovelace', { selector: '[cmdk-item] *' }),
    );
    await waitFor(() => {
      const last = urls()
        .filter((url) => url.pathname === PATH)
        .at(-1);
      expect(JSON.parse(last?.searchParams.get('filter') ?? 'null')).toEqual({
        and: [{ field: 'ownerId', op: 'eq', value: 'user:1' }],
      });
    });
    const searched = urls().filter((url) => url.pathname === '/v1/people');
    expect(searched.at(-1)?.searchParams.get('q')).toBe('ad');
    // The chosen value shows the name, not the key.
    expect(
      screen.getByRole('button', { name: /Owner filter value/i }),
    ).toHaveTextContent('Ada Lovelace');
  });

  const NORTH = '0199a3f2-0000-7000-8000-0000000000a1';
  const ADA = '0199a3f2-0000-7000-8000-000000000001';

  it('names the teams of the filter for any member, and takes "is empty"', async () => {
    stubLayout();
    respond(withRefs, {
      teams: {
        items: [{ id: NORTH, name: 'North', parentId: null, depth: 0 }],
        nextCursor: null,
      },
    });
    const first = await renderList(`?teamId=in.${NORTH}`);
    expect(await screen.findByText('First')).toBeInTheDocument();
    const list = urls().find((url) => url.pathname === PATH);
    expect(JSON.parse(list?.searchParams.get('filter') ?? 'null')).toEqual({
      and: [{ field: 'teamId', op: 'in', value: [NORTH] }],
    });
    // Ref columns the list may select start hidden: `fields=` is unchanged.
    expect(list?.searchParams.get('fields')).toBe('title,status');
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(
      await screen.findByRole('button', { name: /Team filter value/i }),
    ).toHaveTextContent('North');
    // The teams come from the route any member may read.
    expect(urls().some((url) => url.pathname === '/v1/access/teams')).toBe(
      false,
    );
    first.unmount();

    mocks.fetch.mockReset();
    respond(withRefs);
    await renderList('?teamId=is.empty');
    expect(await screen.findByText('First')).toBeInTheDocument();
    await waitFor(() => {
      const last = urls()
        .filter((url) => url.pathname === PATH)
        .at(-1);
      expect(JSON.parse(last?.searchParams.get('filter') ?? 'null')).toEqual({
        and: [{ field: 'teamId', op: 'isNull', value: true }],
      });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names the owner in the filter for a member without manageUsers', async () => {
    stubLayout();
    // `/v1/access/*` answers 403 (respond): only the lookup names ADA.
    respond(withRefs, {
      people: (url: URL) => ({
        items:
          url.searchParams.get('key') === `user:${ADA}`
            ? [{ key: `user:${ADA}`, name: 'Ada Lovelace' }]
            : [],
      }),
    });
    await renderList(`?ownerId=eq.user:${ADA}`);
    expect(await screen.findByText('First')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(
      await screen.findByRole('button', { name: /Owner filter value/i }),
    ).toHaveTextContent('Ada Lovelace');
    expect(urls().some((url) => url.pathname === '/v1/access/principals')).toBe(
      false,
    );
  });

  it('shows the owners and teams of a page by name, in one request each', async () => {
    stubLayout();
    const owners = Array.from(
      { length: 6 },
      (_, n) => `0199a3f2-0000-7000-8000-0000000001${n}0`,
    );
    respond(withRefs, {
      rows: owners.map((owner, n) => ({
        id: String(n),
        title: `Row ${n}`,
        status: 'draft',
        ownerId: `user:${owner}`,
        teamId: NORTH,
      })),
      people: (url: URL) => ({
        items: (url.searchParams.get('key') ?? '')
          .split(',')
          .map((key, n) => ({ key, name: `Person ${n}` })),
      }),
      teams: {
        items: [{ id: NORTH, name: 'North', parentId: null, depth: 0 }],
        nextCursor: null,
      },
    });
    await renderList();
    expect(await screen.findByText('Row 0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View columns' }));
    await userEvent.click(await screen.findByText('Owner'));
    await userEvent.click(await screen.findByText('Team'));

    expect(await screen.findByText('Person 5')).toBeInTheDocument();
    expect(screen.getAllByText('North')).toHaveLength(6);
    const lookups = urls().filter(
      (url) => url.pathname === '/v1/people' && url.searchParams.has('key'),
    );
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.searchParams.get('key')?.split(',')).toEqual(
      owners.map((owner) => `user:${owner}`),
    );
    const teams = urls().filter(
      (url) => url.pathname === '/v1/teams' && url.searchParams.has('id'),
    );
    // One team on six rows: asked once.
    expect(teams).toHaveLength(1);
  });

  it("translates the table's texts", async () => {
    respond(description);
    await renderList('', 'de');

    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Spalten anzeigen' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Zeilen pro Seite')).toBeInTheDocument();
    expect(screen.getByText('Seite 1 von 1')).toBeInTheDocument();
    expect(screen.getByText('0 Zeilen ausgewählt.')).toBeInTheDocument();
  });
});

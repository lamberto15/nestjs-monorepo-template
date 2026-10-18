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

async function renderList(searchParams = '', lng: 'en' | 'de' = 'en') {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    resources: { en: { common: en }, de: { common: de } },
    defaultNS: 'common',
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <NuqsTestingAdapter searchParams={searchParams} hasMemory>
          <TestListPage
            subject="TestItem"
            path={PATH}
            title="Test items"
            columns={columns}
          />
        </NuqsTestingAdapter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
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
      if (url.includes('/v1/access/teams')) {
        return extra.teams
          ? json(extra.teams)
          : json({ status: 403, code: 'forbidden', detail: 'No.' }, 403);
      }
      if (url.includes('/v1/access/principals')) {
        return json({ status: 403, code: 'forbidden', detail: 'No.' }, 403);
      }
      return json({
        items: [
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

  it('names the teams of the filter, and offers only emptiness without access', async () => {
    stubLayout();
    respond(withRefs, {
      teams: {
        items: [
          { id: 'team-1', name: 'North', parentId: null, depth: 0, members: 2 },
        ],
      },
    });
    const first = await renderList('?teamId=in.team-1');
    expect(await screen.findByText('First')).toBeInTheDocument();
    const list = urls().find((url) => url.pathname === PATH);
    expect(JSON.parse(list?.searchParams.get('filter') ?? 'null')).toEqual({
      and: [{ field: 'teamId', op: 'in', value: ['team-1'] }],
    });
    // Ref columns the list may select start hidden: `fields=` is unchanged.
    expect(list?.searchParams.get('fields')).toBe('title,status');
    await userEvent.click(screen.getByRole('button', { name: /Filter/ }));
    expect(
      await screen.findByRole('button', { name: /Team filter value/i }),
    ).toHaveTextContent('North');
    first.unmount();

    // Teams are for access administrators: anyone else gets "is empty".
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

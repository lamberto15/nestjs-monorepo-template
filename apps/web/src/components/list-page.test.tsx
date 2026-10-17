import { createApiClient } from '@nestjs-monorepo-template/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/common.json';
import { ListPage } from './list-page';
import type { ListColumn, ListRow } from '@/lib/list-query';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
// The real client on a mocked fetch: the URLs it builds are what is checked.
vi.mock('@/lib/api', () => ({
  api: createApiClient({
    baseUrl: 'http://api.test',
    fetch: (input: RequestInfo | URL) =>
      mocks.fetch(input) as Promise<Response>,
  }),
}));

// The notes list's row, as the API describes it (the mock sends fewer fields).
type Row = ListRow<'/v1/notes'>;

const description = {
  subject: 'Note',
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

async function renderList(searchParams = '') {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { common: en } },
    defaultNS: 'common',
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <NuqsTestingAdapter searchParams={searchParams}>
          <ListPage
            subject="Note"
            path="/v1/notes"
            title="Notes"
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
            items: [{ id: '1', title: 'First note', status: 'draft' }],
            nextCursor: null,
            page: 1,
            nextPage: null,
            pageCount: 1,
            total: 1,
          }),
    );
    await renderList();

    expect(await screen.findByText('First note')).toBeInTheDocument();
    const list = urls().find((url) => url.pathname === '/v1/notes');
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
      expect(urls().some((url) => url.pathname === '/v1/notes')).toBe(true),
    );
    const list = urls().find((url) => url.pathname === '/v1/notes');
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
              detail: 'You may not read notes.',
            },
            403,
          ),
    );
    await renderList();
    expect(
      await screen.findByText('You may not read notes.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });
});
